// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { startDebugger, continueExecution, stepOver, stepInto, stepOut, restartDebugger, stopDebugger, inspectVariables, testAddingBreakpoints, testRemovingBreakpoints } from './command-interface';
import startDummyAgent from './orchestrator/dummy';
import { applyChanges, showPreviewAndConfirm, showPreviewDiff } from './orchestrator/diff';
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "project-broccoli" is now active!');

	let pendingInspection: 'stepOver' | null = null;

	const stackItemListener = vscode.debug.onDidChangeActiveStackItem(async (stackItem) => {
		if (pendingInspection && stackItem && 'frameId' in stackItem) {
			console.log(`Debugger stopped after ${pendingInspection}, inspecting variables...`);
			pendingInspection = null;

			await inspectVariables();
		}
	});

	context.subscriptions.push(stackItemListener);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const startDebugCommand = vscode.commands.registerCommand('project-broccoli.startDebugger', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		startDebugger();
	});
	context.subscriptions.push(startDebugCommand);

	const continueExecutionCommand = vscode.commands.registerCommand('project-broccoli.continueExecution', () => {
		continueExecution();
	});

	context.subscriptions.push(continueExecutionCommand);

	const stepOverCommand = vscode.commands.registerCommand('project-broccoli.stepOver', async () => {
		pendingInspection = 'stepOver';
		stepOver();
	});

	context.subscriptions.push(stepOverCommand);

	const stepIntoCommand = vscode.commands.registerCommand('project-broccoli.stepInto', () => {
		stepInto();
	});

	context.subscriptions.push(stepIntoCommand);

	const stepOutCommand = vscode.commands.registerCommand('project-broccoli.stepOut', () => {
		stepOut();
	});

	context.subscriptions.push(stepOutCommand);

	const restartDebugCommand = vscode.commands.registerCommand('project-broccoli.restartDebugger', () => {
		restartDebugger();
	});

	context.subscriptions.push(restartDebugCommand);

	const stopDebugCommand = vscode.commands.registerCommand('project-broccoli.stopDebugger', () => {
		stopDebugger();
	});

	context.subscriptions.push(stopDebugCommand);

	const inspectVariablesCommand = vscode.commands.registerCommand('project-broccoli.inspectVariables', async () => {
		inspectVariables();
	});

	context.subscriptions.push(inspectVariablesCommand);

	const testAddingBreakpointsCommand = vscode.commands.registerCommand('project-broccoli.testAddingBreakpoints', () => {
		testAddingBreakpoints();
	});

	context.subscriptions.push(testAddingBreakpointsCommand);

	const testRemovingBreakpointsCommand = vscode.commands.registerCommand('project-broccoli.testRemovingBreakpoints', () => {
		testRemovingBreakpoints();
	});

	context.subscriptions.push(testRemovingBreakpointsCommand);

	const startDummyAgentCommand = vscode.commands.registerCommand('project-broccoli.startDummyAgent', async () => {
		await startDummyAgent();
	});

	context.subscriptions.push(startDummyAgentCommand);

	const testDiff = vscode.commands.registerCommand('project-broccoli.showDiff', async () => {
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			const filePath = activeEditor.document.uri.fsPath;
			await showPreviewAndConfirm(filePath, [{range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)), newText: '# Modified line example'}, 
				{range: new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 5)), newText: '# Changed'}]);
		} else {
			vscode.window.showInformationMessage('No active editor to show diff for');
		}
	});

	context.subscriptions.push(testDiff);
}

// This method is called when your extension is deactivated
export function deactivate() { }
