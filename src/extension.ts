import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type EntityType = 'component' | 'service' | 'directive' | 'pipe' | 'environment' | 'guard' | 'interceptor' | 'module';

// ========== Angular CLI helpers ==========

// ========== Folder discovery helpers ==========

const DIR_EXCLUDE = new Set(['node_modules', '.git', 'dist', '.angular', 'out', '.vscode', 'coverage', '.cache']);

/** Recursively collect all subdirectories (absolute paths), max 8 levels deep. */
function getAllDirs(root: string, depth = 0): string[] {
	if (depth > 8) { return []; }
	const results: string[] = [];
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || DIR_EXCLUDE.has(entry.name) || entry.name.startsWith('.')) { continue; }
			const full = path.join(root, entry.name);
			results.push(full, ...getAllDirs(full, depth + 1));
		}
	} catch { /* ignore permission errors */ }
	return results;
}

/**
 * Show a searchable QuickPick of every directory in the workspace.
 * If `preselected` is an absolute path to a directory, it appears first in the list.
 * Returns the picked absolute path, or undefined if cancelled.
 */
async function pickFolder(workspaceRoot: string, preselected?: string): Promise<string | undefined> {
	const allDirs = [workspaceRoot, ...getAllDirs(workspaceRoot)];

	// Exclude bare "src" and "src/app" — entities should go inside a subfolder of src/app
	const EXCLUDED_SUFFIXES = new Set(['src', path.join('src', 'app'), 'public']);

	type FolderItem = vscode.QuickPickItem & { absPath: string };
	const items: FolderItem[] = allDirs
		.filter(d => {
			const rel = path.relative(workspaceRoot, d);
			return !EXCLUDED_SUFFIXES.has(rel);
		})
		.map(d => {
			const rel = path.relative(workspaceRoot, d).replace(/\\/g, '/');
			return { label: rel || '(project root)', description: d, absPath: d };
		});

	// Move preselected to top
	if (preselected) {
		const idx = items.findIndex(i => i.absPath === preselected);
		if (idx > 0) { items.unshift(...items.splice(idx, 1)); }
	}

	const picked = await vscode.window.showQuickPick<FolderItem>(items, {
		title: 'Select destination folder',
		placeHolder: 'Type to filter folders…',
		matchOnDescription: false
	});
	return picked?.absPath;
}

// ========== Angular project helpers ==========

/** Walk up from startDir looking for angular.json */
function findAngularRoot(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 6; i++) {
		if (fs.existsSync(path.join(dir, 'angular.json'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return null;
}

/** Convert backslashes to forward slashes for ng CLI on Windows */
function toFwdSlash(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Resolve the ng CLI binary path.
 * Prefers the local binary in node_modules/.bin over a global installation.
 */
function getNgCmd(angularRoot: string): string {
	const isWin = process.platform === 'win32';
	const localNg = path.join(angularRoot, 'node_modules', '.bin', isWin ? 'ng.cmd' : 'ng');
	return fs.existsSync(localNg) ? `"${localNg}"` : 'ng';
}

/**
 * Run `ng generate <args>` in the Angular project root.
 * Returns the stdout string.
 * Throws a clean error with stderr content if the command fails.
 */
async function runNgGenerate(angularRoot: string, args: string): Promise<string> {
	const ngCmd = getNgCmd(angularRoot);
	try {
		const { stdout } = await execAsync(`${ngCmd} generate ${args}`, {
			cwd: angularRoot,
			env: { ...process.env }
		});
		return stdout;
	} catch (err: any) {
		throw new Error(err.stderr?.trim() || err.message);
	}
}

/**
 * Parse filenames written by ng (lines starting with "CREATE").
 * Returned paths are absolute.
 */
function parseCreatedFiles(stdout: string, angularRoot: string): string[] {
	const results: string[] = [];
	const re = /CREATE\s+(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stdout)) !== null) {
		results.push(path.join(angularRoot, m[1]));
	}
	return results;
}

/** Open the first .ts file in the list, or the first file if none. */
async function openPrimaryFile(files: string[]): Promise<void> {
	const target = files.find(f => f.endsWith('.ts')) ?? files[0];
	if (target && fs.existsSync(target)) {
		await openFile(target);
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Command 1: Create Angular entity
	const createEntityCommand = vscode.commands.registerCommand(
		'extension.createAngularComponent',
		async (contextUri?: vscode.Uri) => {
			try {
				const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

				// 1. Choose which entity to create
				const entityType = await vscode.window.showQuickPick(
					[
						{ label: 'Component', description: 'Standalone component', value: 'component' },
						{ label: 'Service', description: 'Injectable service', value: 'service' },
						{ label: 'Directive', description: 'Structural or attribute directive', value: 'directive' },
						{ label: 'Pipe', description: 'Custom pipe', value: 'pipe' },
						{ label: 'Environment', description: 'Environment configuration', value: 'environment' },
						{ label: 'Guard', description: 'Route guard', value: 'guard' },
						{ label: 'Interceptor', description: 'HTTP interceptor', value: 'interceptor' },
						{ label: 'Module', description: 'Feature module', value: 'module' }
					],
					{ title: 'Select what you want to create', matchOnDescription: true }
				);

				if (!entityType) { return; }

				const type = entityType.value as EntityType;

				// Environment generates a fixed file set — no name or path needed.
				if (type === 'environment') {
					const angularRoot = findAngularRoot(wsFolder);
					if (!angularRoot) {
						vscode.window.showErrorMessage('angular.json not found. Open an Angular project to use this command.');
						return;
					}
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: 'Generating Environment files…', cancellable: false },
						async () => {
							const stdout = await runNgGenerate(angularRoot, 'environments');
							const files = parseCreatedFiles(stdout, angularRoot);
							await openPrimaryFile(files);
						}
					);
					vscode.window.showInformationMessage('Environment files created successfully');
					return;
				}

				// 2. Pick destination folder
				// If invoked from Explorer context menu on a folder, use that folder directly.
				// Otherwise show the searchable folder picker.
				let destFolder: string | undefined;
				if (contextUri && fs.existsSync(contextUri.fsPath) && fs.statSync(contextUri.fsPath).isDirectory()) {
					destFolder = contextUri.fsPath;
				} else {
					destFolder = await pickFolder(wsFolder);
				}
				if (!destFolder) { return; }

				// Compute path relative to workspace root (forward slashes for ng)
				const relDest = path.relative(wsFolder, destFolder).replace(/\\/g, '/') || '.';

				// 3. Get the name (subfolder if so)
				const name = await vscode.window.showInputBox({
					prompt: `Enter ${entityType.label} name`,
					placeHolder: 'e.g.: folder/my-name or my-name',
					validateInput: (value) => {
						if (!value) { return 'Name cannot be empty'; }
						return null;
					}
				});
				if (!name) { return; }

				// 4. Flat or subfolder? (only relevant for component and module which create subdirs)
				let flat = false;
				if (type === 'component' || type === 'module') {
					const flatChoice = await vscode.window.showQuickPick(
						[
							{ label: 'In subfolder', description: `…/${name}/${name}.${type === 'module' ? 'module' : 'component'}.ts`, value: false },
							{ label: 'Flat', description: `…/${name}.${type === 'module' ? 'module' : 'component'}.ts (no subfolder)`, value: true }
						],
						{ title: 'Folder structure' }
					);
					if (!flatChoice) { return; }
					flat = flatChoice.value;
				}

				// 5. Create entity
				const angularRoot = findAngularRoot(wsFolder);

				let fileToOpen: string | undefined;

				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Generating ${entityType.label} '${name}'…`, cancellable: false },
					async () => {
						if (!angularRoot) {
							vscode.window.showWarningMessage('angular.json not found. Falling back to file template.');
							fileToOpen = await createWithTemplate(wsFolder, type, name, relDest, flat);
							if (type === 'component' && fileToOpen) {
								reformatComponentTemplate(fileToOpen);
							}
							return;
						}

						// ng generate already prepends sourceRoot + "app/" (i.e. "src/app/"),
						// so strip that prefix from the relative path to avoid duplication.
						const ngRel = relDest.replace(/^src\/app\/?/, '').replace(/^src\/?/, '') || '.';
						const ngBase = ngRel === '.' ? name : toFwdSlash(`${ngRel}/${name}`);
						const ngFlags = getNgFlags(type) + (flat ? ' --flat' : '');
						const stdout = await runNgGenerate(angularRoot, `${type} ${ngBase}${ngFlags}`);
						const files = parseCreatedFiles(stdout, angularRoot);
						if (type === 'component') {
							const tsFile = files.find(f => f.endsWith('.component.ts'));
							if (tsFile) { reformatComponentTemplate(tsFile); }
						}
						fileToOpen = files.find(f => f.endsWith('.ts')) ?? files[0];
					}
				);

				// Navigate to the created file after progress is done
				if (fileToOpen && fs.existsSync(fileToOpen)) {
					await openFile(fileToOpen);
				}

				vscode.window.showInformationMessage(`${entityType.label} '${name}' created successfully`);

			} catch (error) {
				vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	);

	// Command 2: Create/link files for the current component
	const manageComponentCommand = vscode.commands.registerCommand(
		'extension.extractInlineTemplate',
		async (contextUri?: vscode.Uri) => {
			try {
				// Resolve file path: from context menu click or from active editor
				let filePath: string | undefined;
				if (contextUri && !fs.statSync(contextUri.fsPath).isDirectory()) {
					filePath = contextUri.fsPath;
				} else {
					const editor = vscode.window.activeTextEditor;
					if (!editor) {
						vscode.window.showErrorMessage('No open file found');
						return;
					}
					filePath = editor.document.fileName;
				}

				const fileName = path.basename(filePath);

				if (!fileName.endsWith('.ts')) {
					vscode.window.showErrorMessage('This command only works in TypeScript files');
					return;
				}

				// Read file content: prefer in-memory editor content if the file is currently open,
				// otherwise read from disk (e.g. when invoked from Explorer context menu).
				const openDoc = vscode.workspace.textDocuments.find(d => d.fileName === filePath);
				const fileContent = openDoc ? openDoc.getText() : fs.readFileSync(filePath, 'utf8');
				const dir = path.dirname(filePath);
				// Strip .component.ts if present, otherwise strip .ts
				const basename = fileName.endsWith('.component.ts')
					? path.basename(filePath, '.component.ts')
					: path.basename(filePath, '.ts');

				// Available options
				const options = await vscode.window.showQuickPick(
					[
						{ label: 'Create/Link HTML', description: 'Extract inline template or create file' },
						{ label: 'Create/Link CSS', description: 'Extract inline styles or create file' },
						{ label: 'Create Tests (spec)', description: 'Create .spec.ts file' }
					],
					{ canPickMany: true, title: 'Select what to create/link' }
				);

				if (!options || options.length === 0) {
					return;
				}

				const createHtml = options.some(o => o.label === 'Create/Link HTML');
				const createCss = options.some(o => o.label === 'Create/Link CSS');
				const createTests = options.some(o => o.label === 'Create Tests (spec)');

				let newContent = fileContent;

				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Processing component files…', cancellable: false },
					async () => {
						// Process HTML
						if (createHtml) {
							const templateMatch = fileContent.match(/template:\s*`([^`]*)`/s);
							const hasTemplateUrl = fileContent.includes('templateUrl:');

							if (templateMatch && !hasTemplateUrl) {
								const htmlPath = path.join(dir, `${basename}.component.html`);
								fs.writeFileSync(htmlPath, templateMatch[1]);
								newContent = newContent.replace(
									/template:\s*`[^`]*`/s,
									`templateUrl: './${basename}.component.html'`
								);
							} else if (!hasTemplateUrl) {
								const htmlPath = path.join(dir, `${basename}.component.html`);
								if (!fs.existsSync(htmlPath)) { fs.writeFileSync(htmlPath, ''); }
								newContent = newContent.replace(/,?\s*template:\s*`[^`]*`/s, '');
								newContent = insertAfterSelector(newContent, `templateUrl: './${basename}.component.html'`);
							}
						}

						// Process CSS — handle both styles: [`...`] (array) and styles: `...` (string)
						if (createCss) {
							const stylesArrayMatch = fileContent.match(/styles:\s*\[\s*`([^`]*)`\s*\]/s);
							const stylesStringMatch = fileContent.match(/styles:\s*`([^`]*)`/s);
							const hasStyleUrl = fileContent.includes('styleUrl:') || fileContent.includes('styleUrls:');

							if ((stylesArrayMatch || stylesStringMatch) && !hasStyleUrl) {
								const cssContent = (stylesArrayMatch ?? stylesStringMatch)![1];
								const cssPath = path.join(dir, `${basename}.component.css`);
								fs.writeFileSync(cssPath, cssContent);
								newContent = newContent
									.replace(/,?\s*styles:\s*\[\s*`[^`]*`\s*\]/s, '')
									.replace(/,?\s*styles:\s*`[^`]*`/s, '');
								newContent = insertAfterSelector(newContent, `styleUrl: './${basename}.component.css'`);
							} else if (!hasStyleUrl) {
								const cssPath = path.join(dir, `${basename}.component.css`);
								if (!fs.existsSync(cssPath)) { fs.writeFileSync(cssPath, ''); }
								newContent = insertAfterSelector(newContent, `styleUrl: './${basename}.component.css'`);
							}
						}

						// Process tests
						if (createTests) {
							const specPath = path.join(dir, `${basename}.component.spec.ts`);
							if (!fs.existsSync(specPath)) {
								const classMatch = fileContent.match(/export\s+class\s+(\w+)/);
								const className = classMatch ? classMatch[1] : 'Component';
								fs.writeFileSync(specPath, generateTestFile(className, basename));
							}
						}
					}
				);

				// Save changes to TS and refresh editor
				if (newContent !== fileContent) {
					fs.writeFileSync(filePath, newContent);
					const document = await vscode.workspace.openTextDocument(filePath);
					await vscode.window.showTextDocument(document);
				}

				vscode.window.showInformationMessage('Files created/linked successfully');

			} catch (error) {
				vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	);

	context.subscriptions.push(createEntityCommand, manageComponentCommand);
}

export function deactivate() {}

function generateComponentTS(
	className: string,
	componentSelector: string,
	hasHtmlFile: boolean,
	hasCssFile: boolean
): string {
	const template = hasHtmlFile
		? `templateUrl: './${componentSelector}.component.html',`
		: `template: \`\`,`;

	const styles = hasCssFile
		? `styleUrls: ['./${componentSelector}.component.css'],`
		: `styles: [\`\`],`;

	return `import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-${componentSelector}',
  ${template}
  ${styles}
  standalone: true,
  imports: []
})
export class ${className}Component {

}
`;
}

/**
 * Insert a new decorator property right after the selector line.
 * Works with both single-quoted and double-quoted selectors.
 */
function insertAfterSelector(content: string, property: string): string {
	return content.replace(
		/(selector:\s*['"][^'"]*['"],?)/,
		`$1\n  ${property},`
	);
}

/**
 * Reformat inline template and styles in a generated component file to multiline.
 * Converts:  template: ` <p>x</p> `  →  template: ` \n    <p>x</p>\n  `
 * Converts:  styles: ``             →  styles: `\n    \n  `
 */
function reformatComponentTemplate(filePath: string): void {
	if (!fs.existsSync(filePath)) { return; }
	let content = fs.readFileSync(filePath, 'utf8');

	// Reformat template
	content = content.replace(/template:\s*`([^`]*)`/s, (_, inner) => {
		const trimmed = inner.trim();
		return `template: \` \n    ${trimmed}\n  \``;
	});

	// Reformat styles (single backtick form generated by ng with --inline-style)
	content = content.replace(/styles:\s*`([^`]*)`/s, (_, inner) => {
		const trimmed = inner.trim();
		const body = trimmed.length > 0 ? `\n    ${trimmed}\n  ` : '\n    \n  ';
		return `styles: \`${body}\``;
	});

	fs.writeFileSync(filePath, content, 'utf8');
}

function generateTestFile(className: string, selector: string): string {
	return `import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ${className} } from './${selector}';

describe('${className}', () => {
  let component: ${className};
  let fixture: ComponentFixture<${className}>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ ${className} ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(${className});
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
`;
}

// ========== ng CLI helpers (flags & fallback) ==========

/**
 * Returns the extra flags to append to `ng generate <type> <path>` for each entity.
 * Flags ensure modern (standalone) output for schematics that support it.
 */
function getNgFlags(type: EntityType): string {
	switch (type) {
		case 'component':  return ' --standalone --inline-style --inline-template --skip-tests';
		case 'directive':  return ' --standalone --skip-tests';
		case 'pipe':       return ' --standalone --skip-tests';
		case 'guard':      return ' --functional --skip-tests';
		case 'service':    return ' --skip-tests';
		case 'interceptor':return ' --skip-tests';
		case 'module':     return '';
		default:           return '';
	}
}

/** Fallback when no angular.json is found — routes to the template helpers. */
async function createWithTemplate(wsFolder: string, type: EntityType, name: string, routePath: string, flat = false): Promise<string | undefined> {
	switch (type) {
		case 'component':   return createComponent(wsFolder, name, routePath, flat);
		case 'service':     return createService(wsFolder, name, routePath);
		case 'directive':   return createDirective(wsFolder, name, routePath);
		case 'pipe':        return createPipe(wsFolder, name, routePath);
		case 'guard':       return createGuard(wsFolder, name, routePath);
		case 'interceptor': return createInterceptor(wsFolder, name, routePath);
		case 'module':      return createModule(wsFolder, name, routePath);
		default:            return undefined;
	}
}

// ========== Create Functions ==========

function toPascalCase(str: string): string {
	return str
		.split('-')
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join('');
}

async function createComponent(wsFolder: string, name: string, routePath: string, flat = false): Promise<string> {
	const fullPath = flat ? path.join(wsFolder, routePath) : path.join(wsFolder, routePath, name);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const className = toPascalCase(name);
	const content = `import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-${name}',
  template: \`\`,
  styles: [\`\`],
  standalone: true,
  imports: [CommonModule]
})
export class ${className}Component {

}
`;

	const filePath = path.join(fullPath, `${name}.component.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function createService(wsFolder: string, name: string, routePath: string): Promise<string> {
	const fullPath = path.join(wsFolder, routePath);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const className = toPascalCase(name);
	const content = `import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ${className}Service {

  constructor() { }
}
`;

	const filePath = path.join(fullPath, `${name}.service.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function createDirective(wsFolder: string, name: string, routePath: string): Promise<string> {
	const fullPath = path.join(wsFolder, routePath);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const className = toPascalCase(name);
	const content = `import { Directive } from '@angular/core';

@Directive({
  selector: '[app${className}]',
  standalone: true
})
export class ${className}Directive {

  constructor() { }
}
`;

	const filePath = path.join(fullPath, `${name}.directive.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function createPipe(wsFolder: string, name: string, routePath: string): Promise<string> {
	const fullPath = path.join(wsFolder, routePath);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const className = toPascalCase(name);
	const content = `import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: '${name}',
  standalone: true
})
export class ${className}Pipe implements PipeTransform {

  transform(value: unknown, ...args: unknown[]): unknown {
    return null;
  }

}
`;

	const filePath = path.join(fullPath, `${name}.pipe.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function createEnvironment(wsFolder: string, name: string, routePath: string): Promise<string> {
	const fullPath = path.join(wsFolder, routePath);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const content = `export const environment = {
  production: false
};
`;

	const filePath = path.join(fullPath, `${name}.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function createGuard(wsFolder: string, name: string, routePath: string): Promise<string> {
	const fullPath = path.join(wsFolder, routePath);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const className = toPascalCase(name);
	const content = `import { Injectable } from '@angular/core';
import { CanActivate, ActivatedRouteSnapshot, RouterStateSnapshot, UrlTree } from '@angular/router';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ${className}Guard implements CanActivate {

  constructor() {}

  canActivate(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot
  ): Observable<boolean | UrlTree> | Promise<boolean | UrlTree> | boolean | UrlTree {
    return true;
  }
}
`;

	const filePath = path.join(fullPath, `${name}.guard.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function createInterceptor(wsFolder: string, name: string, routePath: string): Promise<string> {
	const fullPath = path.join(wsFolder, routePath);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const className = toPascalCase(name);
	const content = `import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable()
export class ${className}Interceptor implements HttpInterceptor {

  constructor() {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(req);
  }
}
`;

	const filePath = path.join(fullPath, `${name}.interceptor.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function createModule(wsFolder: string, name: string, routePath: string): Promise<string> {
	const fullPath = path.join(wsFolder, routePath);
	if (!fs.existsSync(fullPath)) {
		fs.mkdirSync(fullPath, { recursive: true });
	}

	const className = toPascalCase(name);
	const content = `import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

@NgModule({
  declarations: [],
  imports: [
    CommonModule
  ]
})
export class ${className}Module { }
`;

	const filePath = path.join(fullPath, `${name}.module.ts`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

async function openFile(filePath: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument(filePath);
	await vscode.window.showTextDocument(document);
}
