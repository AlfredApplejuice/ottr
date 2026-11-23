import { AsyncLocalStorage } from "node:async_hooks";

type Work<T> = () => T | Promise<T>;

interface TransactionState {
	failed: boolean;
	error: unknown;
	replayable: boolean;
}

export interface StoreQueueScope {
	active: boolean;
	transaction: TransactionState | null;
	queue: StoreQueue;
}

interface TransactionHooks {
	begin: Work<void>;
	commit: Work<void>;
	rollback: Work<void>;
	serialize?<T>(work: () => Promise<T>): Promise<T>;
	retry?<T>(attempt: () => Promise<T>, canReplay: () => boolean): Promise<T>;
	context?: AsyncLocalStorage<StoreQueueScope>;
}

/** One connection owner. Expired async scopes cannot bypass admission or serialization. */
export class StoreQueue {
	private readonly context: AsyncLocalStorage<StoreQueueScope>;
	private readonly hooks: TransactionHooks;
	private tail: Promise<void> = Promise.resolve();
	private closing: Promise<void> | null = null;
	private accepting = true;
	private broken = false;
	private failure: unknown;

	constructor(hooks: TransactionHooks) {
		this.hooks = hooks;
		this.context = hooks.context ?? new AsyncLocalStorage<StoreQueueScope>();
	}

	run<T>(work: Work<T>): Promise<T> {
		const scope = this.context.getStore();
		if (this.broken) {
			return scope?.active
				? this.invoke(() => {
						throw this.failure;
					}, scope)
				: Promise.reject(this.failure);
		}
		if (scope?.active) {
			if (scope.queue === this) return this.invoke(work, scope);
			if (!this.accepting)
				return this.invoke(() => {
					throw new Error("Store is closed");
				}, scope);
			const nested: StoreQueueScope = {
				active: true,
				transaction: scope.transaction,
				queue: this,
			};
			return this.context.run(nested, async () => {
				try {
					return await this.invoke(work, nested);
				} finally {
					nested.active = false;
				}
			});
		}
		return this.admit(work);
	}

	transaction<T>(
		work: Work<T>,
		options: { replay?: boolean } = {},
	): Promise<T> {
		return this.run(async () => {
			const outer = this.context.getStore();
			if (outer?.transaction) {
				if (options.replay === false) outer.transaction.replayable = false;
				return this.invoke(work, outer);
			}
			let state: TransactionState | null = null;
			const attempt = async () => {
				const transaction: TransactionState = {
					failed: false,
					error: undefined,
					replayable: options.replay !== false,
				};
				state = transaction;
				const scope: StoreQueueScope = {
					active: true,
					transaction,
					queue: this,
				};
				await this.hooks.begin();
				try {
					const result = await this.context.run(scope, () =>
						this.invoke(work, scope),
					);
					scope.active = false;
					if (transaction.failed) throw transaction.error;
					await this.hooks.commit();
					return result;
				} catch (error) {
					scope.active = false;
					try {
						await this.hooks.rollback();
					} catch (rollbackError) {
						this.broken = true;
						this.failure = rollbackError;
						throw rollbackError;
					}
					throw error;
				} finally {
					scope.active = false;
				}
			};
			return this.hooks.retry
				? this.hooks.retry(
						attempt,
						() => state?.replayable ?? options.replay !== false,
					)
				: attempt();
		});
	}

	close(work: Work<void>): Promise<void> {
		if (this.closing !== null) return this.closing;
		this.accepting = false;
		this.closing = this.tail.then(work);
		return this.closing;
	}

	private admit<T>(work: Work<T>): Promise<T> {
		if (!this.accepting) return Promise.reject(new Error("Store is closed"));
		const result = this.tail.then(async () => {
			if (this.broken) throw this.failure;
			const scope: StoreQueueScope = {
				active: true,
				transaction: null,
				queue: this,
			};
			try {
				const invoke = () =>
					this.context.run(scope, () => this.invoke(work, scope));
				return await (this.hooks.serialize
					? this.hooks.serialize(invoke)
					: invoke());
			} finally {
				scope.active = false;
			}
		});
		// An application failure must not strand accepted work behind a rejected tail.
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async invoke<T>(work: Work<T>, scope: StoreQueueScope): Promise<T> {
		// SQLite can already have rolled back. Later statements must not autocommit.
		if (scope.transaction?.failed) throw scope.transaction.error;
		try {
			return await work();
		} catch (error) {
			if (scope.transaction !== null && !scope.transaction.failed) {
				scope.transaction.failed = true;
				scope.transaction.error = error;
			}
			throw error;
		}
	}
}
