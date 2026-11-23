import { connect, createServer, type Socket } from "node:net";

interface Rule {
	match: string;
	when: "before" | "reply" | "malformed";
	remaining: number;
}

/** A protocol proxy that can close only the TCP sessions that this fixture creates. */
export async function createPostgresProxy(targetUrl: string) {
	const target = new URL(targetUrl);
	const sockets = new Set<Socket>();
	const queries: string[] = [];
	let rule: Rule | null = null;
	let refuse = false;
	let closing: Promise<void> | null = null;
	const server = createServer((client) => {
		sockets.add(client);
		client.on("error", () => client.destroy());
		client.on("close", () => sockets.delete(client));
		if (refuse || closing) {
			// Refusal must close both directions, even with unread startup bytes.
			client.destroy();
			return;
		}
		const upstream = connect({
			host: target.hostname.replace(/^\[|\]$/g, ""),
			port: Number(target.port || 5432),
		});
		sockets.add(upstream);
		let startup = true;
		let frontend = Buffer.alloc(0);
		let backend = Buffer.alloc(0);
		let dropReply = false;
		let corruptReply = false;
		const close = () => {
			client.destroy();
			upstream.destroy();
		};
		upstream.on("error", close);
		client.on("close", () => {
			upstream.destroy();
		});
		upstream.on("close", () => {
			sockets.delete(upstream);
			client.destroy();
		});
		client.on("data", (chunk) => {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			frontend = Buffer.concat([frontend, bytes]);
			while (frontend.length >= (startup ? 4 : 5)) {
				const length =
					frontend.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
				if (length < (startup ? 8 : 5)) {
					close();
					return;
				}
				if (frontend.length < length) return;
				const frame = frontend.subarray(0, length);
				frontend = frontend.subarray(length);
				if (startup) {
					// The isolated trust fixture uses plaintext. Do not alter TLS settings.
					// SSL/GSS negotiation packets do not end the startup phase.
					const code = frame.readInt32BE(4);
					startup = code === 80877103 || code === 80877104;
				} else {
					const tag = String.fromCharCode(frame.readUInt8(0));
					let sql: string | null = null;
					if (tag === "Q") sql = frame.toString("utf8", 5, frame.length - 1);
					if (tag === "P") {
						const nameEnd = frame.indexOf(0, 5);
						const sqlEnd = frame.indexOf(0, nameEnd + 1);
						if (nameEnd >= 0 && sqlEnd >= 0)
							sql = frame.toString("utf8", nameEnd + 1, sqlEnd);
					}
					if (sql !== null) {
						queries.push(sql);
						if (rule && rule.remaining > 0 && sql.includes(rule.match)) {
							rule.remaining--;
							if (rule.when === "before") {
								close();
								return;
							}
							dropReply = true;
							corruptReply = rule.when === "malformed";
						}
					}
				}
				upstream.write(frame);
			}
		});
		upstream.on("data", (chunk) => {
			if (startup && chunk.length === 1) {
				client.write(chunk);
				return;
			}
			if (!dropReply) {
				client.write(chunk);
				return;
			}
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			backend = Buffer.concat([backend, bytes]);
			while (backend.length >= 5) {
				const length = backend.readInt32BE(1) + 1;
				if (length < 5) {
					close();
					return;
				}
				if (backend.length < length) return;
				const tag = String.fromCharCode(backend.readUInt8(0));
				backend = backend.subarray(length);
				// The server completed the target command. Withhold its reliable reply.
				if (tag === "C" || tag === "E") {
					if (corruptReply) {
						// A syntactically framed ErrorResponse without SQLSTATE cannot
						// prove refusal: the real server already completed this write.
						const fields = Buffer.from(
							"SERROR\0Mprotocol reply missing SQLSTATE\0\0",
						);
						const error = Buffer.alloc(5 + fields.length);
						error.writeUInt8(0x45, 0);
						error.writeInt32BE(4 + fields.length, 1);
						fields.copy(error, 5);
						client.write(
							Buffer.concat([error, Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]),
						);
						backend = Buffer.alloc(0);
						dropReply = false;
						corruptReply = false;
						return;
					}
					close();
					return;
				}
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("PostgreSQL proxy did not open a TCP port.");
	const proxyUrl = new URL(targetUrl);
	proxyUrl.hostname = "127.0.0.1";
	proxyUrl.port = String(address.port);
	return {
		url: proxyUrl.href,
		queries,
		inject(match: string, when: Rule["when"], count = 1) {
			rule = { match, when, remaining: count };
		},
		refuseConnections(value: boolean) {
			refuse = value;
		},
		dropConnections() {
			for (const socket of sockets) socket.destroy();
		},
		close(): Promise<void> {
			if (closing) return closing;
			const closed = Promise.withResolvers<void>();
			closing = closed.promise;
			server.close((error) =>
				error ? closed.reject(error) : closed.resolve(),
			);
			for (const socket of sockets) socket.destroy();
			return closing;
		},
	};
}
