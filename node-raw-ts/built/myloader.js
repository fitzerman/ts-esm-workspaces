"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.load = exports.resolve = void 0;
const url_1 = require("url");
const esbuild_1 = require("esbuild");
const fs_1 = __importDefault(require("fs"));
const { statSync, Stats } = require("fs");
const { emitLegacyIndexDeprecation, getPackageConfig, getPackageScopeConfig, shouldBeTreatedAsRelativeOrAbsolutePath, packageImportsResolve, packageExportsResolve, parsePackageName, } = require("./resolve_nofs");
const { defaultResolveApi, finalizeResolution, ERR_MODULE_NOT_FOUND, } = require("./resolve_fs");
const baseURL = (0, url_1.pathToFileURL)(`${process.cwd()}/`).href;
const isWindows = process.platform === "win32";
function resolve(specifier, context) {
    console.log("RESOLVE: START");
    // Use default but with our own moduleResolve
    return defaultResolveApi(specifier, context, myModuleResolve);
}
exports.resolve = resolve;
async function load(url, context, defaultLoad) {
    console.log("LOAD: START");
    // Return transpiled source if typescript file
    if (isTypescriptFile(url)) {
        // Call defaultLoad to get the source
        const format = getTypescriptModuleFormat();
        const { source: rawSource } = await defaultLoad(url, { format }, defaultLoad);
        const source = transpileTypescript(url, rawSource, "esm");
        return { format, source };
    }
    console.log("LOAD: FORWARD");
    // Let Node.js load it
    return defaultLoad(url, context);
}
exports.load = load;
function isTypescriptFile(url) {
    const extensionsRegex = /\.ts$/;
    return extensionsRegex.test(url);
}
function transpileTypescript(url, source, outputFormat) {
    let filename = url;
    if (!isWindows)
        filename = (0, url_1.fileURLToPath)(url);
    const { code: js, warnings, map: jsSourceMap, } = (0, esbuild_1.transformSync)(source.toString(), {
        sourcefile: filename,
        sourcemap: "both",
        loader: "ts",
        target: "esnext",
        // This sets the output format for the generated JavaScript files
        // format: format === "module" ? "esm" : "cjs",
        format: outputFormat,
    });
    if (warnings && warnings.length > 0) {
        for (const warning of warnings) {
            console.log(warning.location);
            console.log(warning.text);
        }
    }
    return js;
}
function getTypescriptModuleFormat() {
    // The format of typescript file could be ESM or CJS
    // Since typescript always generates .js files, it can be a module if type: module is set in package.json
    // However it can also be a module otherwise......
    // Is it even important to know this, the source is loaded in the same way regardless.......
    // Perhaps we cannot transpile CJS into ESM with esbuild? Then we need to know...
    // An ECMAScript module in JS cannot use require
    // A typescript module can use require but can it in the same module use ESM import/export?
    return "module";
}
/*

We always start with a typescript file (foo.ts) and a tsconfig.json.

We only need to handle imports with relative or bare specifiers.

* The relative specifier can be extensionless or have a .js extension
* The bare specifier could resolve to an extensionless or a .js file

When something resolves to a .js file, we need to determine if that .js file is part of the current compilation.
The .js may not exist in the filesystem becuase tsc may have not been run yet.
If a .js file is part of the current compilation, we need to backtrack to find the .ts file that generated it and load that instead

So instead of just chaning the extension from .js to .ts, or just adding .ts to the exensionless specifier

*/
/**
 * @param {string} specifier
 * @param {string | URL | undefined} base
 * @param {Set<string>} conditions
 * @returns {URL}
 */
function myModuleResolve(specifier, base, conditions) {
    console.log("myModuleResolve: START");
    // Order swapped from spec for minor perf gain.
    // Ok since relative URLs cannot parse as URLs.
    let resolved;
    if (shouldBeTreatedAsRelativeOrAbsolutePath(specifier)) {
        console.log("myModuleResolve: resolveFilePath");
        resolved = new url_1.URL(specifier, base);
        // resolved = resolveFilePath(specifier, base);
    }
    else if (specifier[0] === "#") {
        console.log("myModuleResolve: packageImportsResolve");
        ({ resolved } = packageImportsResolve(packageResolve, specifier, base, conditions));
    }
    else {
        console.log("myModuleResolve: else");
        try {
            resolved = new url_1.URL(specifier);
        }
        catch {
            console.log("myModuleResolve: packageResolve");
            resolved = packageResolve(specifier, base, conditions);
        }
    }
    console.log("myModuleResolve: END", resolved.href);
    // Now we should have resolved to an URL with file-path (eg. foo.js),
    // It could also be to resolved to an extensionless file at this point...
    // We should check if
    // the resolved file is in the output space of the tsconfig used.
    // If it is we need to map it back to the typescript file that will compile to the resolved file
    // and resolve to that file instead
    resolved = translateJsUrlBackToTypescriptUrl(resolved);
    // finalizeResolution checks for old file endings....
    return finalizeResolution(resolved, base);
}
/**
 * We get an url to a javascript file and should try to back-track
 * to the typescript file that would compile to that javascript file.
 * @param url
 * @returns url
 */
function translateJsUrlBackToTypescriptUrl(url) {
    // If file ends in .ts use it as-is
    if (isTypescriptFile(url.href)) {
        return url;
    }
    // Try to add `.ts` extension and resolve
    const path = (0, url_1.fileURLToPath)(url) + ".ts";
    console.log("translateJsUrlBackToTypescriptUrl pathpathpath", path);
    if (fs_1.default.existsSync(path)) {
        console.log("RESOLVE: RETURN", url.href);
        return (0, url_1.pathToFileURL)(path);
    }
    return url;
}
/**
 * This function resolves bare specifiers that refers to packages (not node:, data: bare specifiers)
 * @param {string} specifier
 * @param {string | URL | undefined} base
 * @param {Set<string>} conditions
 * @returns {URL}
 */
function packageResolve(specifier, base, conditions) {
    // Parse the specifier as a package name (package or @org/package) and separate out the sub-path
    const { packageName, packageSubpath, isScoped } = parsePackageName(specifier, base);
    // ResolveSelf
    // Check if the specifier resolves to the same package we are resolving from
    const selfResolved = resolveSelf(base, packageName, packageSubpath, conditions);
    if (selfResolved)
        return selfResolved;
    // Find package.json by ascending the file system
    const packageJsonMatch = findPackageJson(packageName, base, isScoped);
    // If package.json was found, resolve from it's exports or main field
    if (packageJsonMatch) {
        const [packageJSONUrl, packageJSONPath] = packageJsonMatch;
        const packageConfig = getPackageConfig(packageJSONPath, specifier, base);
        if (packageConfig.exports !== undefined && packageConfig.exports !== null)
            return packageExportsResolve(packageResolve, packageJSONUrl, packageSubpath, packageConfig, base, conditions).resolved;
        if (packageSubpath === ".")
            return legacyMainResolve(packageJSONUrl, packageConfig, base);
        return new url_1.URL(packageSubpath, packageJSONUrl);
    }
    // eslint can't handle the above code.
    // eslint-disable-next-line no-unreachable
    throw new ERR_MODULE_NOT_FOUND(packageName, (0, url_1.fileURLToPath)(base));
}
// This could probably be moved to a built-in API
function findPackageJson(packageName, base, isScoped) {
    let packageJSONUrl = new url_1.URL("./node_modules/" + packageName + "/package.json", base);
    let packageJSONPath = (0, url_1.fileURLToPath)(packageJSONUrl);
    let lastPath;
    do {
        const stat = tryStatSync(
        // StringPrototypeSlice(packageJSONPath, 0, packageJSONPath.length - 13)
        packageJSONPath.slice(0, packageJSONPath.length - 13));
        if (!stat.isDirectory()) {
            lastPath = packageJSONPath;
            packageJSONUrl = new url_1.URL((isScoped ? "../../../../node_modules/" : "../../../node_modules/") +
                packageName +
                "/package.json", packageJSONUrl);
            packageJSONPath = (0, url_1.fileURLToPath)(packageJSONUrl);
            continue;
        }
        // Package match.
        return [packageJSONUrl, packageJSONPath];
        // Cross-platform root check.
    } while (packageJSONPath.length !== lastPath.length);
    return undefined;
}
// This could probably be moved to a built-in API
// However it needs packageResolve since it calls into packageExportsResolve()
function resolveSelf(base, packageName, packageSubpath, conditions) {
    const packageConfig = getPackageScopeConfig(base);
    if (packageConfig.exists) {
        const packageJSONUrl = (0, url_1.pathToFileURL)(packageConfig.pjsonPath);
        if (packageConfig.name === packageName &&
            packageConfig.exports !== undefined &&
            packageConfig.exports !== null) {
            return packageExportsResolve(packageResolve, packageJSONUrl, packageSubpath, packageConfig, base, conditions).resolved;
        }
    }
    return undefined;
}
/**
 * Legacy CommonJS main resolution:
 * 1. let M = pkg_url + (json main field)
 * 2. TRY(M, M.js, M.json, M.node)
 * 3. TRY(M/index.js, M/index.json, M/index.node)
 * 4. TRY(pkg_url/index.js, pkg_url/index.json, pkg_url/index.node)
 * 5. NOT_FOUND
 * @param {URL} packageJSONUrl
 * @param {PackageConfig} packageConfig
 * @param {string | URL | undefined} base
 * @returns {URL}
 */
function legacyMainResolve(packageJSONUrl, packageConfig, base) {
    let guess;
    if (packageConfig.main !== undefined) {
        // Note: fs check redundances will be handled by Descriptor cache here.
        if (fileExists((guess = new url_1.URL(`./${packageConfig.main}`, packageJSONUrl)))) {
            return guess;
        }
        else if (fileExists((guess = new url_1.URL(`./${packageConfig.main}.js`, packageJSONUrl)))) {
        }
        else if (fileExists((guess = new url_1.URL(`./${packageConfig.main}.json`, packageJSONUrl)))) {
        }
        else if (fileExists((guess = new url_1.URL(`./${packageConfig.main}.node`, packageJSONUrl)))) {
        }
        else if (fileExists((guess = new url_1.URL(`./${packageConfig.main}/index.js`, packageJSONUrl)))) {
        }
        else if (fileExists((guess = new url_1.URL(`./${packageConfig.main}/index.json`, packageJSONUrl)))) {
        }
        else if (fileExists((guess = new url_1.URL(`./${packageConfig.main}/index.node`, packageJSONUrl)))) {
        }
        else
            guess = undefined;
        if (guess) {
            emitLegacyIndexDeprecation(guess, packageJSONUrl, base, packageConfig.main);
            return guess;
        }
        // Fallthrough.
    }
    if (fileExists((guess = new url_1.URL("./index.js", packageJSONUrl)))) {
    }
    else if (fileExists((guess = new url_1.URL("./index.json", packageJSONUrl)))) {
    }
    else if (fileExists((guess = new url_1.URL("./index.node", packageJSONUrl)))) {
    }
    else
        guess = undefined;
    if (guess) {
        emitLegacyIndexDeprecation(guess, packageJSONUrl, base, packageConfig.main);
        return guess;
    }
    // Not found.
    throw new ERR_MODULE_NOT_FOUND((0, url_1.fileURLToPath)(new url_1.URL(".", packageJSONUrl)), (0, url_1.fileURLToPath)(base));
}
/**
 * @param {string | URL} path
 * @returns {import('fs').Stats}
 */
const tryStatSync = (path) => statSync(path, { throwIfNoEntry: false }) ?? new Stats();
/**
 * @param {string | URL} url
 * @returns {boolean}
 */
function fileExists(url) {
    return statSync(url, { throwIfNoEntry: false })?.isFile() ?? false;
}
