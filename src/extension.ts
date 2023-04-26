import { AzureExtensionApiProvider } from "@microsoft/vscode-azext-utils/api";
import {
  CancellationToken,
  commands,
  CompletionItem,
  CompletionItemKind,
  EventEmitter,
  ExtensionContext,
  extensions,
  languages,
  Position,
  TextDocument,
  TextDocumentContentProvider,
  Uri,
  window,
  workspace,
} from "vscode";
import {
  installTools,
  startLocalProcess,
  stopLocalProcess,
  stopLocalProcessByServerName,
} from "./commands/installTools";
import {
  addNewConnection,
  connect,
  disconnect,
  removeConnection,
  runQuery,
} from "./commands/serverCommand";
import {
  hideWalkthrough,
  showInstallationDetails,
  showWalkthrough,
} from "./commands/walkthroughCommand";
import { ext } from "./extensionVariables";
import { ExecutionTypes } from "./models/execution";
import { QueryResult } from "./models/queryResult";
import { Server } from "./models/server";
import { KdbNode, KdbTreeProvider } from "./services/kdbTreeProvider";
import {
  checkLocalInstall,
  formatTable,
  getServers,
  initializeLocalServers,
  isTable,
} from "./utils/core";
import { runQFileTerminal } from "./utils/execution";
import AuthSettings from "./utils/secretStorage";
import { Telemetry } from "./utils/telemetryClient";

export async function activate(context: ExtensionContext) {
  ext.context = context;
  ext.outputChannel = window.createOutputChannel("kxdb");

  // integration wtih Azure Account extension (https://marketplace.visualstudio.com/items?itemName=ms-vscode.azure-account)
  ext.azureAccount = (<AzureExtensionApiProvider>(
    extensions.getExtension("ms-vscode.azure-account")!.exports
  )).getApi("1.0.0");

  const servers: Server | undefined = getServers();
  ext.serverProvider = new KdbTreeProvider(servers!);
  window.registerTreeDataProvider("kdb-servers", ext.serverProvider);

  // initialize local servers
  if (servers !== undefined) {
    initializeLocalServers(servers);
    ext.serverProvider.refresh(servers);
  }

  // initialize the secret store
  AuthSettings.init(context);
  ext.secretSettings = AuthSettings.instance;

  // check for installed Q runtime
  await checkLocalInstall();

  // hide walkthrough if requested
  if (await showWalkthrough()) {
    commands.executeCommand(
      "workbench.action.openWalkthrough",
      "kx.kxdb-vscode#qinstallation",
      false
    );
  }

  context.subscriptions.push(
    commands.registerCommand("kxdb.connect", async (viewItem: KdbNode) => {
      await connect(viewItem);
    }),
    commands.registerCommand("kxdb.disconnect", async () => {
      await disconnect();
    }),
    commands.registerCommand("kxdb.addConnection", async () => {
      await addNewConnection();
    }),
    commands.registerCommand(
      "kxdb.removeConnection",
      async (viewItem: KdbNode) => {
        await removeConnection(viewItem);
      }
    ),
    commands.registerCommand("kxdb.hideWalkthrough", async () => {
      await hideWalkthrough();
    }),
    commands.registerCommand("kxdb.showInstallationDetails", async () => {
      await showInstallationDetails();
    }),
    commands.registerCommand("kxdb.installTools", async () => {
      await installTools();
    }),
    commands.registerCommand(
      "kxdb.startLocalProcess",
      async (viewItem: KdbNode) => {
        await startLocalProcess(viewItem);
      }
    ),
    commands.registerCommand(
      "kxdb.stopLocalProcess",
      async (viewItem: KdbNode) => {
        await stopLocalProcess(viewItem);
      }
    ),

    commands.registerCommand("kxbd.terminal.run", () => {
      const filename = window.activeTextEditor?.document.fileName;
      if (filename) runQFileTerminal(filename);
    }),
    commands.registerCommand("kxbd.execute.selectedQuery", async () => {
      runQuery(ExecutionTypes.QuerySelection);
    }),
    commands.registerCommand("kxbd.execute.fileQuery", async () => {
      runQuery(ExecutionTypes.QueryFile);
    })
  );

  const lastResult: QueryResult | undefined = undefined;
  const resultSchema = "vscode-kdb-q";
  const resultProvider = new (class implements TextDocumentContentProvider {
    onDidChangeEmitter = new EventEmitter<Uri>();
    onDidChange = this.onDidChangeEmitter.event;

    provideTextDocumentContent(uri: Uri): string {
      const result = lastResult!;

      const headers = result.meta.map((m) => m.c);
      const aligns = result.meta.map((m) => (m.t === "f" ? "." : "1"));
      const opts = { align: aligns, keys: result.keys };
      const data = result.data;

      const text: string = isTable(result)
        ? formatTable(headers, data, opts)
        : data;
      return text;
    }
  })();

  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider(resultSchema, resultProvider)
  );

  context.subscriptions.push(
    languages.registerCompletionItemProvider("q", {
      provideCompletionItems(
        document: TextDocument,
        position: Position,
        token: CancellationToken
      ) {
        const items: CompletionItem[] = [];
        const getInsertText = (x: string) => {
          if ((x.match(/\./g) || []).length > 1) {
            return x.substr(1);
          }
          return x;
        };

        ext.keywords.forEach((x) =>
          items.push({ label: x, kind: CompletionItemKind.Keyword })
        );
        ext.functions.forEach((x) =>
          items.push({
            label: x,
            insertText: getInsertText(x),
            kind: CompletionItemKind.Function,
          })
        );
        ext.tables.forEach((x) =>
          items.push({
            label: x,
            insertText: getInsertText(x),
            kind: CompletionItemKind.Value,
          })
        );
        ext.variables.forEach((x) =>
          items.push({
            label: x,
            insertText: getInsertText(x),
            kind: CompletionItemKind.Variable,
          })
        );

        return items;
      },
    })
  );

  // Telemetry.sendEvent('Extension.Activated');
}

export async function deactivate(): Promise<void> {
  await Telemetry.dispose();

  // cleanup of local Q instance processes
  Object.keys(ext.localProcessObjects).forEach((index) => {
    stopLocalProcessByServerName(index);
  });

  if (!ext.client) {
    return undefined;
  }
  return ext.client.stop();
}
