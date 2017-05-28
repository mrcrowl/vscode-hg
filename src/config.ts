import { workspace } from "vscode"

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

    get commandMode(): "server" | "cli" {
        return this.get<"server" | "cli">("commandMode", "cli")
    }
}

const typedConfig = new Config()
export default typedConfig