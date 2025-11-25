// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { startDebugger, continueExecution, stepOver, stepInto, stepOut, restartDebugger, stopDebugger } from './command-interface';
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "project-broccoli" is now active!');

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
	
	const stepOverCommand = vscode.commands.registerCommand('project-broccoli.stepOver', () => {
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
}

// This method is called when your extension is deactivated
export function deactivate() {}
