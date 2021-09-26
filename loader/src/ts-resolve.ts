import { URL, pathToFileURL, fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import { loadTsConfigAndResolveReferences, Tsconfig } from "./tsconfig-loader";
const { statSync, Stats } = require("fs");

const {
  emitLegacyIndexDeprecation,
  getPackageConfig,
  getPackageScopeConfig,
  shouldBeTreatedAsRelativeOrAbsolutePath,
  packageImportsResolve,
  packageExportsResolve,
  parsePackageName,
  getConditionsSet,
} = require("./resolve_nofs");

const { finalizeResolution, ERR_MODULE_NOT_FOUND } = require("./resolve_fs");

type TsConfigInfo = {
  tsconfigMap: Map<string, Tsconfig>;
  absOutDirToTsConfig: Map<string, string>;
};

const entryTsConfigInfoCache: Map<string, TsConfigInfo> = new Map();

type ResolveContext = {
  conditions: string[];
  parentURL: string | undefined;
};

type ResolveReturn = {
  format?: null | undefined | string;
  url: string;
};

/**
 * specifier {string}
 * context {Object}
 *   conditions {string[]}
 *   parentURL {string|undefined}
 * defaultResolve {Function} The Node.js default resolver.
 * Returns: {Object}
 *   format {string|null|undefined} 'builtin' | 'commonjs' | 'json' | 'module' | 'wasm'
 *   url {string} The absolute url to the import target (such as file://…)
 */
export function resolve(
  specifier: string,
  context: ResolveContext,
  defaultResolve
): ResolveReturn {
  console.log("RESOLVE: START");

  // parentURL is the URL returned by previous resolve, so it is not the specifier that did the import but the resolved specifier
  // If a ./foo.ts file was resolved for
  // import xxxx from "./foo.js"
  // Then ./foo.ts file will be the parentURL, not foo.js
  // This means abs/relative imports never need mapping of path from output to input
  let { parentURL, conditions } = context;
  console.log("RESOLVE: parentURL", parentURL);

  // Let node handle `data:` and `node:` prefix etc.
  const excludeRegex = /^\w+:/;
  if (excludeRegex.test(specifier)) {
    return defaultResolve(specifier, context, defaultResolve);
  }

  // Build tsconfig map if we don't have it
  const entryTsConfig = process.env["TS_NODE_PROJECT"];
  if (!entryTsConfig) {
    throw new Error("TS_NODE_PROJECT must be defined for now...");
  }
  let tsConfigInfo = entryTsConfigInfoCache.get(entryTsConfig);
  if (tsConfigInfo === undefined) {
    tsConfigInfo = buildTsConfigInfo(entryTsConfig);
    entryTsConfigInfoCache.set(entryTsConfig, tsConfigInfo);
  }

  // If file ends in .ts then just return it
  // This can only happen for the entry file as typescript does not allow
  // import of .ts files
  if (isTypescriptFile(specifier)) {
    const url = new URL(specifier, parentURL).href;
    return { url };
  }

  // Try to resolve to a typescript file
  const conditionsSet = getConditionsSet(conditions);
  const resolved = myModuleResolve(
    specifier,
    parentURL,
    conditionsSet,
    tsConfigInfo
  );
  if (resolved !== undefined) {
    const [url, format] = resolved;
    console.log("it was resolved", url.href, format);
    return { url: `${url}`, format };
  }

  // Not resolved as typescript, forward to default resolve
  return defaultResolve(specifier, context, defaultResolve);
}

/**
 * @param {string} specifier
 * @param {string | URL | undefined} base
 * @param {Set<string>} conditions
 * @returns {URL}
 */
function myModuleResolve(
  specifier: string,
  base: string | undefined,
  conditions: Set<string>,
  tsConfigInfo: TsConfigInfo
): readonly [URL, string] | undefined {
  console.log("myModuleResolve: START");

  // Resolve path specifiers
  if (shouldBeTreatedAsRelativeOrAbsolutePath(specifier)) {
    console.log("myModuleResolve: resolveFilePath");
    const resolved = new URL(specifier, base);
    // console.log("myModuleResolve: tsConfigInfo", tsConfigInfo);
    // const tsConfigAbsPath = getTsConfigAbsPathForOutFile(
    //   tsConfigInfo,
    //   resolved
    // );
    // console.log("myModuleResolve: tsConfigAbsPath", tsConfigAbsPath);
    // if (tsConfigAbsPath) {
    //   // If the file was in the output space of a tsconfig, then just
    //   // probe for file-ext as there can be no path-mapping for abs/rel paths
    //   const tsFile = probeForTsExtFile(resolved);
    //   console.log("myModuleResolve: tsFile", tsFile);
    //   if (tsFile !== undefined) {
    //     return [new URL(tsFile), tsConfigAbsPath];
    //   }
    // }
    console.log("myModuleResolve: resolved", resolved.href);

    const tsFileUrl = probeForTsFileInSamePathAsJsFile(resolved);
    if (tsFileUrl !== undefined) {
      // This file belongs to the same TsConfig as it's ParentUrl, but we don't know
      // which TsConfig the ParentUrl belongs to....
      // Or is it allowed in typescript composite project to make a relative import to a file in a different TsConfig?
      return [tsFileUrl, "SameAsParent"];
    }
    return undefined;
  }

  // Resolve bare specifiers
  let possibleUrls: ReadonlyArray<URL>;
  if (specifier[0] === "#") {
    console.log("myModuleResolve: packageImportsResolve");
    const { resolved } = packageImportsResolve(
      packageResolve,
      specifier,
      base,
      conditions
    )!;
    possibleUrls = [resolved];
  } else {
    console.log("myModuleResolve: else");
    try {
      possibleUrls = [new URL(specifier)];
    } catch {
      console.log("myModuleResolve: packageResolve");
      possibleUrls = packageResolve(specifier, base, conditions);
      console.log(
        "myModuleResolve: packageResolve RETURN",
        Array.isArray(possibleUrls)
      );
    }
  }
  console.log("myModuleResolve: END");

  // // At this point the bare specifier is resolved to one or more possible JS files
  // if (!Array.isArray(possibleUrls)) {
  //   resolved = [resolved];
  // }

  // if (Array.isArray(resolved)) {
  //   resolved = probeForLegacyIndex(resolved);
  // }

  // if (possibleUrls === undefined || possibleUrls.length === 0) {
  //   return undefined;
  // }

  // Check which tsconfig this file belongs to and translate the path....
  // for (const [outDir, tsconfig] of absoluteOutDirToTsConfigMap!.entries()) {
  // }

  // Now we should have resolved to an URL with file-path (eg. foo.js),
  // It could also be to resolved to an extensionless file at this point...
  // We should check if
  // the resolved file is in the output space of the tsconfig used.
  // If it is we need to map it back to the typescript file that will compile to the resolved file
  // and resolve to that file instead

  // Cannot be a .ts file since that case only exists for the entry file and is handled directly in resolve()
  // Do we want to support extensionless files? In that case we need to check if it is
  // a directory or file... Typescript always outputs .js files so we could just add that?

  // const resolved2 = translateJsUrlBackToTypescriptUrl(resolved);
  console.log("bare specifiier possibleUrls", possibleUrls.length);
  for (const possibleUrl of possibleUrls) {
    const tsFile = probeForTsFileInSamePathAsJsFile(possibleUrl);
    if (tsFile !== undefined) {
      // finalizeResolution checks for old file endings if getOptionValue("--experimental-specifier-resolution") === "node"
      const finalizedUrl = finalizeResolution(tsFile, base);
      return [finalizedUrl, "typescript"];
    }
  }
  return undefined;
}

function getTsConfigAbsPathForOutFile(
  tsConfigInfo: TsConfigInfo,
  fileUrl: URL
): string | undefined {
  const filePath = fileURLToPath(fileUrl);
  for (const key of tsConfigInfo.absOutDirToTsConfig.keys()) {
    if (filePath.startsWith(key)) return key;
  }
  return undefined;
}

/**
 * Given a file with a javascript extension, probe for a file with
 * typescript extension in the exact same path.
 */
function probeForTsFileInSamePathAsJsFile(jsFileUrl: URL): URL | undefined {
  // The jsFile can be extensionless or have another extension
  // so we remove any extension and try with .ts and .tsx
  const jsFilePath = fileURLToPath(jsFileUrl);
  const parsedPath = path.parse(jsFilePath);
  const extensionless = path.join(parsedPath.dir, parsedPath.name);
  if (fileExists(extensionless + ".ts")) {
    return pathToFileURL(extensionless + ".ts");
  }
  if (fileExists(extensionless + ".tsx")) {
    return pathToFileURL(extensionless + ".tsx");
  }
}

/**
 * We get an url to a javascript file and should try to back-track
 * to the typescript file that would compile to that javascript file.
 * @param url
 * @returns url
 */
function translateJsUrlBackToTypescriptUrl(url) {
  // Try to add `.ts` extension and resolve
  const path = fileURLToPath(url) + ".ts";
  console.log("translateJsUrlBackToTypescriptUrl pathpathpath", path);
  if (fs.existsSync(path)) {
    console.log("RESOLVE: RETURN", url.href);
    return pathToFileURL(path);
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
function packageResolve(
  specifier: string,
  base: string | URL | undefined,
  conditions: Set<string>
): ReadonlyArray<URL> {
  // Parse the specifier as a package name (package or @org/package) and separate out the sub-path
  const { packageName, packageSubpath, isScoped } = parsePackageName(
    specifier,
    base
  );

  // ResolveSelf
  // Check if the specifier resolves to the same package we are resolving from
  const selfResolved = resolveSelf(
    base,
    packageName,
    packageSubpath,
    conditions
  );
  if (selfResolved) return [selfResolved];

  // Find package.json by ascending the file system
  const packageJsonMatch = findPackageJson(packageName, base, isScoped);

  // If package.json was found, resolve from it's exports or main field
  if (packageJsonMatch) {
    const [packageJSONUrl, packageJSONPath] = packageJsonMatch;
    const packageConfig = getPackageConfig(packageJSONPath, specifier, base);
    if (packageConfig.exports !== undefined && packageConfig.exports !== null) {
      const per = packageExportsResolve(
        packageResolve,
        packageJSONUrl,
        packageSubpath,
        packageConfig,
        base,
        conditions
      ).resolved;
      return per ? [per] : [];
    }
    if (packageSubpath === ".")
      // return legacyMainResolve(packageJSONUrl, packageConfig, base);
      return legacyMainResolve2(packageJSONUrl, packageConfig);
    return [new URL(packageSubpath, packageJSONUrl)];
  }

  // eslint can't handle the above code.
  // eslint-disable-next-line no-unreachable
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base ?? ""));
}

// This could probably be moved to a built-in API
function findPackageJson(packageName, base, isScoped) {
  let packageJSONUrl = new URL(
    "./node_modules/" + packageName + "/package.json",
    base
  );
  let packageJSONPath = fileURLToPath(packageJSONUrl);
  let lastPath;
  do {
    const stat = tryStatSync(
      // StringPrototypeSlice(packageJSONPath, 0, packageJSONPath.length - 13)
      packageJSONPath.slice(0, packageJSONPath.length - 13)
    );
    if (!stat.isDirectory()) {
      lastPath = packageJSONPath;
      packageJSONUrl = new URL(
        (isScoped ? "../../../../node_modules/" : "../../../node_modules/") +
          packageName +
          "/package.json",
        packageJSONUrl
      );
      packageJSONPath = fileURLToPath(packageJSONUrl);
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
    const packageJSONUrl = pathToFileURL(packageConfig.pjsonPath);
    if (
      packageConfig.name === packageName &&
      packageConfig.exports !== undefined &&
      packageConfig.exports !== null
    ) {
      return packageExportsResolve(
        packageResolve,
        packageJSONUrl,
        packageSubpath,
        packageConfig,
        base,
        conditions
      ).resolved;
    }
  }
  return undefined;
}

// /**
//  * Legacy CommonJS main resolution:
//  * 1. let M = pkg_url + (json main field)
//  * 2. TRY(M, M.js, M.json, M.node)
//  * 3. TRY(M/index.js, M/index.json, M/index.node)
//  * 4. TRY(pkg_url/index.js, pkg_url/index.json, pkg_url/index.node)
//  * 5. NOT_FOUND
//  * @param {URL} packageJSONUrl
//  * @param {PackageConfig} packageConfig
//  * @param {string | URL | undefined} base
//  * @returns {URL}
//  */
// function legacyMainResolve(packageJSONUrl, packageConfig, base) {
//   let guess;
//   if (packageConfig.main !== undefined) {
//     // Note: fs check redundances will be handled by Descriptor cache here.
//     if (
//       fileExists((guess = new URL(`./${packageConfig.main}`, packageJSONUrl)))
//     ) {
//       return guess;
//     } else if (
//       fileExists(
//         (guess = new URL(`./${packageConfig.main}.js`, packageJSONUrl))
//       )
//     ) {
//     } else if (
//       fileExists(
//         (guess = new URL(`./${packageConfig.main}.json`, packageJSONUrl))
//       )
//     ) {
//     } else if (
//       fileExists(
//         (guess = new URL(`./${packageConfig.main}.node`, packageJSONUrl))
//       )
//     ) {
//     } else if (
//       fileExists(
//         (guess = new URL(`./${packageConfig.main}/index.js`, packageJSONUrl))
//       )
//     ) {
//     } else if (
//       fileExists(
//         (guess = new URL(`./${packageConfig.main}/index.json`, packageJSONUrl))
//       )
//     ) {
//     } else if (
//       fileExists(
//         (guess = new URL(`./${packageConfig.main}/index.node`, packageJSONUrl))
//       )
//     ) {
//     } else guess = undefined;
//     if (guess) {
//       emitLegacyIndexDeprecation(
//         guess,
//         packageJSONUrl,
//         base,
//         packageConfig.main
//       );
//       return guess;
//     }
//     // Fallthrough.
//   }
//   if (fileExists((guess = new URL("./index.js", packageJSONUrl)))) {
//   } else if (fileExists((guess = new URL("./index.json", packageJSONUrl)))) {
//   } else if (fileExists((guess = new URL("./index.node", packageJSONUrl)))) {
//   } else guess = undefined;
//   if (guess) {
//     emitLegacyIndexDeprecation(guess, packageJSONUrl, base, packageConfig.main);
//     return guess;
//   }
//   // Not found.
//   throw new ERR_MODULE_NOT_FOUND(
//     fileURLToPath(new URL(".", packageJSONUrl)),
//     fileURLToPath(base)
//   );
// }

function probeForLegacyIndex(urls) {
  for (const url of urls) {
    if (fileExists(url)) {
      emitLegacyIndexDeprecation(
        url,
        "packageJSONUrl",
        "base",
        "packageConfig.main"
      );
      return url;
    }
  }
}

// type LegacyIndexGuess = {
//   path: string;
//   packageJSONUrl: URL;
//   base: string;
//   packageConfigMain: string;
// };

/**
 * Legacy CommonJS main resolution:
 * 1. let M = pkg_url + (json main field)
 * 2. TRY(M, M.js, M.json, M.node)
 * 3. TRY(M/index.js, M/index.json, M/index.node)
 * 4. TRY(pkg_url/index.js, pkg_url/index.json, pkg_url/index.node)
 * 5. NOT_FOUND
 * @param {PackageConfig} packageConfig
 * @param {string | URL | undefined} base
 * @returns {URL}
 */
function legacyMainResolve2(packageJSONUrl, packageConfig): ReadonlyArray<URL> {
  const guess: Array<URL> = [];
  if (packageConfig.main !== undefined) {
    guess.push(
      ...[
        new URL(`./${packageConfig.main}.node`, packageJSONUrl),
        new URL(`./${packageConfig.main}`, packageJSONUrl),
        new URL(`./${packageConfig.main}.js`, packageJSONUrl),
        new URL(`./${packageConfig.main}.json`, packageJSONUrl),
        new URL(`./${packageConfig.main}.node`, packageJSONUrl),
        new URL(`./${packageConfig.main}/index.js`, packageJSONUrl),
        new URL(`./${packageConfig.main}/index.json`, packageJSONUrl),
        new URL(`./${packageConfig.main}/index.node`, packageJSONUrl),
      ]
    );
  }
  guess.push(
    ...[
      new URL("./index.js", packageJSONUrl),
      new URL("./index.json", packageJSONUrl),
      new URL("./index.node", packageJSONUrl),
    ]
  );
  return guess;
}

/**
 * @param {string | URL} path
 * @returns {import('fs').Stats}
 */
const tryStatSync = (path) =>
  statSync(path, { throwIfNoEntry: false }) ?? new Stats();

/**
 * @param {string | URL} url
 * @returns {boolean}
 */
function fileExists(url) {
  return statSync(url, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isTypescriptFile(url) {
  const extensionsRegex = /\.ts$/;
  return extensionsRegex.test(url);
}

function buildTsConfigInfo(entryTsConfig: string): TsConfigInfo {
  const tsconfigMap = loadTsConfigAndResolveReferences(entryTsConfig);
  const absOutDirToTsConfig = new Map();
  for (const [k, v] of tsconfigMap.entries()) {
    if (v.compilerOptions?.outDir === undefined) {
      throw new Error("Outdir must be defined for now...");
    }
    const absoluteOutDir = path.resolve(
      path.dirname(k),
      v.compilerOptions.outDir
    );
    absOutDirToTsConfig.set(absoluteOutDir, k);
  }
  return {
    tsconfigMap,
    absOutDirToTsConfig,
  };
}
