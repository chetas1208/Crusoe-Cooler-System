// Metro for the pnpm monorepo. Expo's default config already watches the workspace root and
// resolves the hoisted node_modules; the workspace packages (@loopkeeper/core, @loopkeeper/scene)
// ship raw TypeScript (`main: src/index.ts`), which Metro transpiles like app code.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// react-three-fiber/native `require('three')`s while the scene `import`s it. Under package
// exports those would resolve to two different files (three.cjs vs three.module.js) — two
// copies of three, and the CJS build calls `process.emitWarning`, which React Native lacks.
// Pin every `three` request to the single ESM build.
const path = require('path');
const threeEsm = path.join(path.dirname(require.resolve('three')), 'three.module.js');
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'three') return { type: 'sourceFile', filePath: threeEsm };
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
