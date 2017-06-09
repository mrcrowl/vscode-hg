import { workspace } from "vscode"

export type PushPullScopeOptions = "default" | "current" | "all" | undefined;
export type CommandModeOptions = "server" | "cli" | undefined;

class Config {
    private get config() {
        return workspace.getConfiguration('hg')
    }

    private get<T>(name: keyof Config, defaultValue: T): T {
        const value = this.config.get<T>(name)
        if (value === undefined) {
            return defaultValue
        }
        return value
    }

    get autoRefresh(): boolean {
        return this.get("autoRefresh", true)
    }

    get useBookmarks(): boolean {
        return this.get("useBookmarks", false)
    }

    get allowPushNewBranches(): boolean {
        return this.get("allowPushNewBranches", false);
    }

    get commandMode(): CommandModeOptions {
        return this.get<CommandModeOptions>("commandMode", "cli")
    }

    get pushPullScope(): PushPullScopeOptions {
        return this.get<PushPullScopeOptions>("pushPullScope", "all");
    }

    get pushPullBranch(): PushPullScopeOptions {
        return this.get<PushPullScopeOptions>("pushPullBranch", this.pushPullScope);
    }
}

const typedConfig = new Config()
export default typedConfig