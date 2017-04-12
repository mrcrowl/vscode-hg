import { Model } from "./model";
import { workspace, Disposable, Uri, Event, EventEmitter } from "vscode";

const LOG_URI = "hg-log://hg/log";

// export class HgLogProvider {
//     private disposables: Disposable[] = [];

//     private onDidChangeEmitter = new EventEmitter<Uri>();
//     get onDidChange(): Event<Uri> { return this.onDidChangeEmitter.event; }

//     constructor(private model: Model) {
//         this.disposables.push(
//             // model.onDidChangeRepository(this.eventuallyFireChangeEvents, this),
//             workspace.registerTextDocumentContentProvider('hg-log', this)
//         );

//         // setInterval(() => this.cleanup(), FIVE_MINUTES);
//     }

//     // async provideTextDocumentContent(uri: Uri): Promise<string> {
//     //     this.model.getLogEntries();
//     // }


//     dispose(): void {
//         this.disposables.forEach(d => d.dispose());
//     }

//     public static getLogUri(): Uri {
//         return Uri.parse(LOG_URI);
//     }
// }