export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface RuntimePlugin<TContext = unknown> {
  name: string;
  start(context: TContext): Disposable | Promise<Disposable>;
}

export class RuntimePluginHost<TContext> implements Disposable {
  private readonly active: Array<{ plugin: RuntimePlugin<TContext>; disposable: Disposable }> = [];

  constructor(private readonly context: TContext) {}

  async mount(plugin: RuntimePlugin<TContext>): Promise<void> {
    if (this.active.some((entry) => entry.plugin.name === plugin.name)) {
      throw new Error(`Runtime plugin already mounted: ${plugin.name}`);
    }
    const disposable = await plugin.start(this.context);
    this.active.push({ plugin, disposable });
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of this.active.splice(0).reverse()) {
      try { await entry.disposable.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Runtime plugin disposal failed.");
  }

  list(): string[] {
    return this.active.map((entry) => entry.plugin.name);
  }
}
