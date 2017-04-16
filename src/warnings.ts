import * as nls from "vscode-nls";
import { window } from "vscode";
import { Model } from "./model";

const localize = nls.loadMessageBundle();

export enum WarnScenario {
	Merge,
	Update
}

export async function warnOutstandingMerge(this: void, model: Model, scenario: WarnScenario): Promise<boolean> {
    const { repoStatus } = model;
    if (repoStatus && repoStatus.isMerge) {
        window.showErrorMessage(localize('outstanding merge', "There is an outstanding merge in your working directory."));
        return true;
    }
    return false;
}

export async function warnUnclean(this: void, model: Model, scenario: WarnScenario): Promise<boolean> {
    if (!model.isClean) {
        let nextStep: string = "";
        if (scenario === WarnScenario.Merge) {
            const discardAllChanges = localize('command.cleanAll', "Discard All Changes");
            const abandonMerge = localize('abandon merge', "abandon merge");
            localize('use x to y', "Use {0} to {1}", discardAllChanges, abandonMerge);
        }
        window.showErrorMessage(localize('not clean merge', "There are uncommited changes in your working directory. {0}", nextStep));
        return true;
    }
    return false;
}