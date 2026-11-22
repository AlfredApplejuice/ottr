/**
 * OTTR-1180: a real-interface ssh-keygen stub for tests. The real tool dies on hosts whose
 * uid has no passwd entry — ssh-keygen runs getpwuid at startup, and a worker container's
 * ephemeral uid (a host account mapping) fails it — which takes down every key fixture and
 * every key route that reaches production generatePendingKey/keyInfo/importPendingKey.
 * The stub answers the three command lines the suite and the app make, as a bun script the
 * caller prepends to PATH (src/test/suiteEnv.ts restores the ambient PATH after each test):
 * generation (`-q -t ed25519 -N <pass> -C <comment> -f <path>`), public export
 * (`-y -P "" -f <path>`), and fingerprinting (`-l -E sha256 -f <path|->`, one key line per
 * input line, known_hosts forms included). Keys are fresh ed25519 pairs from node:crypto;
 * the private half serializes as PKCS8 PEM, which OpenSSH reads like its own format. A
 * `-N` passphrase writes a genuinely encrypted PKCS8 key (PBES2), and the export decrypts
 * only with that passphrase, so the import path keeps rejecting protected keys through a
 * real decryption failure.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `#!/usr/bin/env bun
// ottr test stub: an ssh-keygen for hosts without a usable uid (OTTR-1180).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const get = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
	console.error(msg);
	process.exit(255);
};
const pubLine = (key, comment) => {
	const pub = key.type === "public" ? key : createPublicKey(key);
	const der = pub.export({ type: "spki", format: "der" });
	const raw = der.subarray(der.length - 32);
	const w = (b) => {
		const l = Buffer.alloc(4);
		l.writeUInt32BE(b.length);
		return Buffer.concat([l, b]);
	};
	const blob = Buffer.concat([w(Buffer.from("ssh-ed25519")), w(raw)]);
	return "ssh-ed25519 " + blob.toString("base64") + (comment ? " " + comment : "");
};

const f = get("-f");
if (args.includes("-l")) {
	const algo = get("-E") ?? "sha256";
	if (algo !== "sha256" && algo !== "md5")
		fail("ssh-keygen: unknown digest " + algo);
	const input = f === "-"
		? await new Response(Bun.stdin.stream()).text()
		: existsSync(f) ? readFileSync(f, "utf8") : fail("ssh-keygen: " + f + ": No such file or directory");
	for (const line of input.split("\\n")) {
		const m = line.match(/(ssh-ed25519|ssh-rsa|ecdsa-sha2-\\S+)\\s+([A-Za-z0-9+/=]+)/);
		if (!m) continue;
		if (algo === "md5") {
			const fp = createHash("md5").update(Buffer.from(m[2], "base64")).digest("hex").replace(/(..)(?=.)/g, "$1:");
			console.log("256 MD5:" + fp + " (ED25519)");
		} else {
			const fp = createHash("sha256").update(Buffer.from(m[2], "base64")).digest("base64").replace(/=+$/, "");
			console.log("256 SHA256:" + fp + " (ED25519)");
		}
	}
	process.exit(0);
}
if (args.includes("-y")) {
	const pass = get("-P") ?? "";
	const text = existsSync(f) ? readFileSync(f, "utf8") : fail("ssh-keygen: " + f + ": No such file or directory");
	let key;
	try {
		key = pass === ""
			? createPrivateKey(text)
			: createPrivateKey({ key: text, format: "pem", passphrase: pass });
	} catch {
		fail("ssh-keygen: key is malformed or has a passphrase");
	}
	process.stdout.write(pubLine(key, "") + "\\n");
	process.exit(0);
}
if (get("-t") === "ed25519") {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const pass = get("-N") ?? "";
	const body = pass === ""
		? privateKey.export({ type: "pkcs8", format: "pem" })
		: privateKey.export({
				type: "pkcs8",
				format: "pem",
				passphrase: pass,
				cipher: "aes-128-cbc",
			});
	writeFileSync(f, body, { mode: 0o600 });
	writeFileSync(f + ".pub", pubLine(publicKey, get("-C") ?? "") + "\\n");
	process.exit(0);
}
fail("ssh-keygen stub: unsupported call: " + args.join(" "));
`;

let dir: string | null = null;

/** The stub dir; prepend it to PATH so every ssh-keygen spawn resolves here. A sibling
 * file's afterAll may have removed the shared dir (one module instance per process), so a
 * missing script rebuilds it. */
export function sshKeygenStubDir(): string {
	if (dir === null || !existsSync(join(dir, "ssh-keygen"))) {
		dir = mkdtempSync(join(tmpdir(), "ottr-ssh-keygen-stub-"));
		writeFileSync(join(dir, "ssh-keygen"), SCRIPT, { mode: 0o755 });
	}
	return dir;
}

/** Prepends the stub dir to the ambient PATH; run once per test from a beforeEach. */
export function installSshKeygenStub(): void {
	process.env.PATH = `${sshKeygenStubDir()}:${process.env.PATH ?? ""}`;
}

/** Removes the stub dir (call once from an afterAll). */
export function removeSshKeygenStub(): void {
	if (dir !== null) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		dir = null;
	}
}
