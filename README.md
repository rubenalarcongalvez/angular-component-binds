# Angular Component Binds

VS Code extension to create Angular entities and manage component files quickly.

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-❤-ea4aaa?logo=github)](https://github.com/sponsors/rubenalarcongalvez) [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/S6S619M4ED)

## Commands

### 1. Create Angular Entity

Shortcut: `Ctrl+Shift+A C` (Windows/Linux) or `Cmd+Shift+A C` (Mac)

Supported entities:

- Component
- Service
- Directive
- Pipe
- Environment
- Guard
- Interceptor
- Module

Flow:

1. Select entity type
2. Select destination folder from a searchable project folder picker
3. Enter name (kebab-case)
   1. It could be by creating other folders like "folder/my-name" or just creating the component like "my-"
4. Choose Flat or In subfolder (for Component and Module)

Notes:

- The folder picker hides base folders: `src`, `src/app`, and `public`.
- If launched from Explorer on a folder, that folder is used directly.
- Uses `ng generate` when `angular.json` is available.
- Falls back to file templates if no Angular project is detected.
- Opens the created file automatically when done.

### 2. Manage Component Files

Shortcut: `Ctrl+Shift+A M` (Windows/Linux) or `Cmd+Shift+A M` (Mac)

From a TypeScript file, lets you:

- Create/Link HTML
- Create/Link CSS
- Create Tests (spec)

What it does:

- Extracts inline template/styles to separate files when present
- Links `templateUrl` and `styleUrl` in the component decorator
- Generates a basic `.spec.ts` file with the correct class name

## Explorer Context Menu

- Folder: `Angular: Create Entity here…`
- `.component.ts` file: `Angular: Manage Component Files…`
