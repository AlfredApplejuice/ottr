/**
 * vm-runner disk images (docs/adr/0009-microvm-workers.md):
 * - base rootfs: an ext4 copy of this container's own root (the vm-runner image ships the
 *   same bun, omp and /app as a worker), read-only vda of every VM. Keyed by the content
 *   of the guest files it copies (BASE_INPUTS below) plus OTTR_VERSION and
 *   `omp --version`, so any change to a copied guest file rebuilds it once.
 * - project layer: an ext4 holding the overlay `upper/` and `work/` dirs a bake VM fills with
 *   the project's apt/tools/pip installs (the worker's per-turn installs, done once). Keyed
 *   by the base key plus the dispatch's provisioning list texts (docs/specs/vm-list-isolation.md),
 *   so a changed list re-bakes and nothing else does.
 * Only the current base and the current layer per project stay on disk; a VM still running
 * on an older image keeps its open inode.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	renameSync,
	rmSync,
	type Stats,
} from "node:fs";
import { join } from "node:path";
import type { Exec } from "./vmNet.ts";
import type { ProvisionLists } from "./workers.ts";

/** Paths the base rootfs never copies: kernel filesystems, mounts, per-host state. */
const BASE_EXCLUDES = [
	"/proc",
	"/sys",
	"/dev",
	"/run",
	"/tmp",
	"/data",
	"/root",
	"/var/lib/ottr-vm",
] as const;

/** Mount points the guest init needs in the copy, which the excludes dropped. */
const MOUNT_POINTS = ["proc", "sys", "dev", "run", "tmp", "data", "root"];

/**
 * The copied guest paths the base key hashes: everything the image build adds on top of
 * Debian (the init at /usr/local/bin/ottr-vm-init, /app with the guest agent, the kernel
 * at /opt/ottr-vm/vmlinux, bun and omp under /usr/local/bun, the other external tools)
 * plus the dpkg inventory for the apt toolchain. /etc and the Debian /usr stay out on
 * purpose: dpkg status covers them at package granularity, and the docker-written
 * /etc/hosts and resolv.conf must never key the base (they change per container restart).
 */
const BASE_INPUTS = [
	"/app",
	"/opt",
	"/usr/local",
	"/var/lib/dpkg/status",
] as const;

export interface BakeResult {
	exitCode: number | null;
	stderrTail: string;
}

export type LayerResult =
	| { ok: true; path: string }
	| { ok: false; stderrTail: string };

function baseKey(i: {
	ottrVersion: string;
	ompVersion: string;
	/** Per BASE_INPUTS path: the copied content's digest, null when absent. */
	guests: (readonly [string, string | null])[];
}): string {
	// JSON keeps the parts unambiguous: "a"+"bc" and "ab"+"c" must not collide.
	return createHash("sha256")
		.update(JSON.stringify([i.ottrVersion, i.ompVersion, i.guests]))
		.digest("hex");
}

/** sha256 of a file's content, read in chunks so a big binary never sits in the heap. */
function fileDigest(path: string): string {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.allocUnsafe(HASH_CHUNK);
		for (;;) {
			const n = readSync(fd, buf, 0, HASH_CHUNK, null);
			if (n === 0) break;
			hash.update(buf.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/**
 * Content digest of one copied guest path under the image root `root`: a file hashes by
 * content, a symlink by its target, a directory by its sorted children's digests; null
 * when absent. The sorted names keep the digest stable across readdir order, and a
 * symlink never gets followed as a directory, so there is no cycle.
 */
function guestDigest(root: string, rel: string): string | null {
	const at = join(root, rel);
	let st: Stats;
	try {
		st = lstatSync(at);
	} catch {
		return null;
	}
	if (st.isSymbolicLink()) return `l:${readlinkSync(at)}`;
	if (st.isFile()) return `f:${fileDigest(at)}`;
	const parts: string[] = [];
	for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
		a.name < b.name ? -1 : 1,
	))
		parts.push(
			`${entry.name}\u0000${guestDigest(root, `${rel}/${entry.name}`) ?? "?"}`,
		);
	return `d:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}

/**
 * The list files a bake of `project` installs, one entry per present field, at the
 * guest-absolute paths the guest's ensure wrappers read (docs/specs/vm-list-isolation.md).
 * The bake copies these texts in memory; no shared-home file is ever read here.
 */
export function listFiles(
	project: string,
	lists: ProvisionLists,
): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	const root = "/root/.ottr/workers";
	const at = (dir: string, file: string): string => `${root}/${dir}/${file}`;
	if (lists.apt !== undefined)
		out.push({ path: at(project, "apt.txt"), text: lists.apt });
	if (lists.tools !== undefined)
		out.push({ path: at(project, "tools.json"), text: lists.tools });
	if (lists.toolsAll !== undefined)
		out.push({ path: at("_all", "tools.json"), text: lists.toolsAll });
	if (lists.requirements !== undefined)
		out.push({
			path: at(project, "requirements.txt"),
			text: lists.requirements,
		});
	if (lists.requirementsAll !== undefined)
		out.push({
			path: at("_all", "requirements.txt"),
			text: lists.requirementsAll,
		});
	return out;
}

export function layerKey(base: string, lists: ProvisionLists): string {
	// A missing list (null) and an empty one ("") install the same, but keeping them apart
	// costs one extra bake at most and never reuses a wrong layer.
	return createHash("sha256")
		.update(
			JSON.stringify([
				base,
				[
					lists.apt ?? null,
					lists.tools ?? null,
					lists.toolsAll ?? null,
					lists.requirements ?? null,
					lists.requirementsAll ?? null,
				],
			]),
		)
		.digest("hex");
}

/** A sparse file of `bytes`: mkfs.ext4 then only writes its metadata. */
export function sparseFile(path: string, bytes: number): void {
	const fd = openSync(path, "w");
	try {
		ftruncateSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

async function run(exec: Exec, argv: string[], okCodes = [0]): Promise<string> {
	const r = await exec(argv);
	if (r.code === null || !okCodes.includes(r.code))
		throw new Error(
			`${argv[0]} failed: ${(r.stderr || r.stdout).trim().slice(-2000) || `exit ${r.code}`}`,
		);
	return r.stdout;
}

/** Removes every entry of `dir` but `keep` (best effort). */
function keepOnly(dir: string, keep: string): void {
	for (const name of readdirSync(dir))
		if (name !== keep)
			rmSync(join(dir, name), { recursive: true, force: true });
}

const MIB = 1024 * 1024;

/** Hash chunk for the guest file digests (fileDigest). */
const HASH_CHUNK = 8 * MIB;

export class VmRootfs {
	private basePromise: Promise<{ key: string; path: string }> | null = null;
	/** Per project: the tail of its bake chain, so two turns never bake one layer twice. */
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(
		private readonly o: {
			stateDir: string;
			homeRoot: string;
			exec: Exec;
			ottrVersion: string;
			/** Apparent size of a fresh layer image (sparse). */
			layerBytes: number;
			/** The root the base copies; "/" outside tests. */
			sourceRoot?: string;
		},
	) {}

	/** The current base rootfs; built on first use. A failed build retries on the next call. */
	base(): Promise<{ key: string; path: string }> {
		if (!this.basePromise) {
			this.basePromise = this.buildBase();
			this.basePromise.catch(() => {
				this.basePromise = null;
			});
		}
		return this.basePromise;
	}

	private async buildBase(): Promise<{ key: string; path: string }> {
		const { exec, stateDir } = this.o;
		const key = baseKey({
			ottrVersion: this.o.ottrVersion,
			ompVersion: (await run(exec, ["omp", "--version"])).trim(),
			guests: BASE_INPUTS.map(
				(p) => [p, guestDigest(this.o.sourceRoot ?? "/", p)] as const,
			),
		});
		const dir = join(stateDir, "base");
		const path = join(dir, `${key}.ext4`);
		mkdirSync(dir, { recursive: true });
		if (existsSync(path)) {
			keepOnly(dir, `${key}.ext4`);
			return { key, path };
		}
		const staging = join(stateDir, "base-staging");
		const tarFile = join(stateDir, "base-staging.tar");
		rmSync(staging, { recursive: true, force: true });
		rmSync(tarFile, { force: true });
		try {
			const excludes = [...BASE_EXCLUDES, stateDir].map(
				(p) => `--exclude=.${p}`,
			);
			// --one-file-system also skips the bind-mounted /etc/hosts and resolv.conf; the
			// guest init writes its own. Exit 1 is "a file changed while read", harmless here.
			await run(
				exec,
				[
					"tar",
					"--one-file-system",
					"-C",
					this.o.sourceRoot ?? "/",
					"-cpf",
					tarFile,
					"--anchored",
					...excludes,
					".",
				],
				[0, 1],
			);
			mkdirSync(staging, { recursive: true });
			await run(exec, ["tar", "-C", staging, "-xpf", tarFile]);
			rmSync(tarFile, { force: true });
			for (const m of MOUNT_POINTS)
				mkdirSync(join(staging, m), { recursive: true });
			chmodSync(join(staging, "tmp"), 0o1777);
			const bytes = Number(
				(await run(exec, ["du", "-sb", staging])).split(/\s/)[0],
			);
			const inodes = Number(
				(await run(exec, ["du", "-s", "--inodes", staging])).split(/\s/)[0],
			);
			if (!Number.isFinite(bytes) || !Number.isFinite(inodes))
				throw new Error(`du could not size ${staging}`);
			// ext4 metadata and the journal need headroom; 4 MiB alignment keeps mkfs happy.
			const size =
				Math.ceil((bytes + Math.max(bytes / 4, 512 * MIB)) / (4 * MIB)) *
				4 *
				MIB;
			const tmp = `${path}.tmp`;
			sparseFile(tmp, size);
			await run(exec, [
				"mkfs.ext4",
				"-F",
				"-q",
				"-L",
				"ottr-base",
				"-N",
				String(Math.ceil(inodes * 1.25) + 16384),
				"-d",
				staging,
				tmp,
			]);
			renameSync(tmp, path);
			keepOnly(dir, `${key}.ext4`);
			return { key, path };
		} finally {
			rmSync(staging, { recursive: true, force: true });
			rmSync(tarFile, { force: true });
		}
	}

	/**
	 * The project's current layer image, baked through `bake` (a bake-mode VM with the image
	 * as rw vdb) when its key changed. Bakes of one project run one at a time: the second
	 * turn waits and then finds the first one's layer.
	 */
	layer(
		project: string,
		lists: ProvisionLists,
		bake: (image: string) => Promise<BakeResult>,
	): Promise<LayerResult> {
		const prev = this.chains.get(project) ?? Promise.resolve();
		const next = prev.then(() => this.layerNow(project, lists, bake));
		const tail = next.catch(() => {});
		this.chains.set(project, tail);
		tail.then(() => {
			if (this.chains.get(project) === tail) this.chains.delete(project);
		});
		return next;
	}

	private async layerNow(
		project: string,
		lists: ProvisionLists,
		bake: (image: string) => Promise<BakeResult>,
	): Promise<LayerResult> {
		const base = await this.base();
		const key = layerKey(base.key, lists);
		const dir = join(this.o.stateDir, "layers", project);
		const path = join(dir, `${key}.ext4`);
		if (existsSync(path)) return { ok: true, path };
		mkdirSync(dir, { recursive: true });
		const nonce = randomBytes(4).toString("hex");
		const tmp = join(dir, `${key}.ext4.tmp-${nonce}`);
		const staging = join(dir, `staging-${nonce}`);
		try {
			mkdirSync(join(staging, "upper"), { recursive: true });
			mkdirSync(join(staging, "work"), { recursive: true });
			sparseFile(tmp, this.o.layerBytes);
			await run(this.o.exec, [
				"mkfs.ext4",
				"-F",
				"-q",
				"-L",
				"ottr-layer",
				"-d",
				staging,
				tmp,
			]);
			rmSync(staging, { recursive: true, force: true });
			const r = await bake(tmp);
			if (r.exitCode !== 0)
				return {
					ok: false,
					stderrTail:
						r.stderrTail || `the package bake exited ${r.exitCode ?? "killed"}`,
				};
			// The bake VM must leave the layer's journal clean: a run mounts it read-only
			// and cannot replay it (the guest then powers off). e2fsck exit 0 or 1 means
			// the image is clean now (1 = errors corrected); anything else fails the bake
			// with the check's output, like a failed apt install does.
			const check = await this.o.exec(["e2fsck", "-fy", tmp]);
			if (check.code === null || check.code >= 2)
				return {
					ok: false,
					stderrTail: `the layer image failed its post-bake check (e2fsck exit ${check.code ?? "?"}):\n${(check.stdout + check.stderr).trim().slice(-2000)}`,
				};
			renameSync(tmp, path);
			keepOnly(dir, `${key}.ext4`);
			return { ok: true, path };
		} finally {
			rmSync(staging, { recursive: true, force: true });
			rmSync(tmp, { force: true });
		}
	}
}
