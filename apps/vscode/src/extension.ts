import * as vscode from 'vscode';

type Source = { label: string; kind: string; tokens: number; action: string };

const sources: Source[] = [
  { label: 'build-output.log', kind: 'Terminal output', tokens: 6800, action: 'Summarize output' },
  { label: '12 enabled tools', kind: 'Tool schemas', tokens: 2100, action: 'Review tools' },
  { label: '11 earlier turns', kind: 'Chat history', tokens: 1000, action: 'Clean handoff' }
];

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ContextTopFixProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ContextTopFixProvider.viewType, provider));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  status.text = '$(pulse) Context 18.4k est. · 74% · Fix';
  status.tooltip = 'Open contextTop Fix';
  status.command = 'contextTop.openFix';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(vscode.commands.registerCommand('contextTop.openFix', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.contextTop');
  }));
}

class ContextTopFixProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'contextTop.fix';
  private view?: vscode.WebviewView;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async message => {
      if (message.type === 'fix') {
        await vscode.window.showInformationMessage(`contextTop will ${message.action.toLowerCase()} before the next request.`);
      }
    });
  }

  private html(): string {
    const bars = [32, 41, 47, 54, 72, 65, 74, 57, 48, 62, 70, 74].map((height, index) => `<i style="height:${height}%" title="${index * 5}s"></i>`).join('');
    const rows = sources.map(source => `<li><span><b>${source.label}</b><small>${source.kind} · ${source.tokens.toLocaleString()} tokens</small></span><button data-action="${source.action}">${source.action}</button></li>`).join('');
    return `<!doctype html><html><body><main><header><div><p>LIVE CONTEXT · 5 SECOND WINDOWS</p><h2>Context is getting expensive</h2></div><strong>18.4k <small>estimated tokens</small></strong></header><section class="chart"><div class="budget">74% of usable budget</div><div class="bars">${bars}</div><div class="axis"><span>−55s</span><span>now</span></div></section><section class="summary"><span>Files <b>5.3k</b></span><span>Terminal <b>6.8k</b></span><span>Tools <b>2.1k</b></span><span>History <b>1.0k</b></span></section><section><h3>contextTop Fix <em>save ~8.2k tokens</em></h3><ul>${rows}</ul></section></main><script>document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'fix',action:button.dataset.action})));</script><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);margin:0}main{padding:12px 16px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;align-items:center}p{font-size:10px;font-weight:700;color:var(--vscode-descriptionForeground);margin:0}h2{font-size:15px;margin:4px 0}header strong{font-size:18px}small{display:block;font-size:10px;color:var(--vscode-descriptionForeground);font-weight:400}.chart{height:92px;border-bottom:1px solid var(--vscode-widget-border);position:relative;margin-top:10px}.budget{position:absolute;right:0;top:4px;color:#e6a04d;font-size:10px}.bars{height:74px;display:flex;align-items:end;gap:5px;padding-top:18px}.bars i{display:block;flex:1;max-width:30px;background:linear-gradient(#e5a44e 0 42%,#5771e7 42%);border-radius:3px 3px 0 0}.axis{display:flex;justify-content:space-between;font-size:9px;color:var(--vscode-descriptionForeground)}.summary{display:flex;gap:14px;padding:11px 0;font-size:10px}.summary span{color:var(--vscode-descriptionForeground)}.summary b{color:var(--vscode-foreground);margin-left:3px}h3{font-size:12px;margin:4px 0 6px}em{font-size:10px;font-style:normal;font-weight:400;color:#43b89e;margin-left:7px}ul{list-style:none;padding:0;margin:0}li{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--vscode-widget-border);padding:8px 0;font-size:11px}li b{display:block}button{font:11px var(--vscode-font-family);border:1px solid var(--vscode-button-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:4px;padding:4px 7px;cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}</style></body></html>`;
  }
}
