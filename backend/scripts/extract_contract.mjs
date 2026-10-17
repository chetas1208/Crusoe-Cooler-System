#!/usr/bin/env node
/**
 * Extract a machine-readable description of packages/core/src/contracts.ts
 * (interfaces, type aliases, READING_META) using the TypeScript compiler AST.
 *
 *   node backend/scripts/extract_contract.mjs [--write]
 *
 * With --write the result is stored in backend/tests/contracts/contracts.golden.json, which the
 * Python parity tests compare the Pydantic models against. Without it, JSON goes to stdout.
 * The golden file is committed so `pytest` needs no node toolchain; a separate test re-extracts
 * (when node + typescript are available) and fails if contracts.ts has drifted from the golden.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

// contracts.ts + the sibling wire-type files owned by the frontend packages (control, runs).
const FILES = [
  ['contracts.ts', 'contracts'],
  ['contracts.control.ts', 'control'],
  ['runs/types.ts', 'runs'],
].map(([f, tag]) => [path.join(root, 'packages', 'core', 'src', f), tag]);
let sf; // current source file (used by describe())

const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
/** Describe a type node; inline object literal types (also inside Array<>/[]) get their members. */
function describe(node) {
  const d = { type: norm(node.getText(sf)) };
  let lit = null;
  if (ts.isTypeLiteralNode(node)) lit = node;
  else if (ts.isArrayTypeNode(node) && ts.isTypeLiteralNode(node.elementType)) { lit = node.elementType; d.array = true; }
  else if (ts.isTypeReferenceNode(node) && node.typeName.getText(sf) === 'Array' && node.typeArguments?.length === 1 && ts.isTypeLiteralNode(node.typeArguments[0])) { lit = node.typeArguments[0]; d.array = true; }
  if (lit) {
    d.members = {};
    for (const m of lit.members) if (ts.isPropertySignature(m)) d.members[m.name.getText(sf)] = { optional: !!m.questionToken, ...describe(m.type) };
  }
  return d;
}
const out = { interfaces: {}, aliases: {}, reading_meta: {}, arrays: {} };

function extract(file, tag) {
sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
for (const st of sf.statements) {
  if (ts.isInterfaceDeclaration(st)) {
    const fields = {};
    for (const m of st.members) {
      if (!ts.isPropertySignature(m)) continue;
      fields[m.name.getText(sf)] = { optional: !!m.questionToken, ...describe(m.type) };
    }
    out.interfaces[st.name.text] = {
      type_params: (st.typeParameters ?? []).map((p) => p.name.text),
      fields,
      source: tag,
    };
  } else if (ts.isTypeAliasDeclaration(st)) {
    out.aliases[st.name.text] = norm(st.type.getText(sf));
    out.alias_sources ??= {}; out.alias_sources[st.name.text] = tag;
  } else if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) {
      const name = d.name.getText(sf);
      if (name === 'FAULT_CATALOG') continue;
      if (name === 'HTTP_STATUS_FOR_CODE' && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
        out.http_status_for_code = Object.fromEntries(d.initializer.properties.map((p) => [p.name.getText(sf), Number(p.initializer.text)]));
        continue;
      }
      if (name === 'READING_META' && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
        for (const p of d.initializer.properties) {
          const v = {};
          for (const q of p.initializer.properties) {
            const k = q.name.getText(sf);
            v[k] = ts.isNumericLiteral(q.initializer) ? Number(q.initializer.text) : q.initializer.text;
          }
          out.reading_meta[p.name.getText(sf)] = v;
        }
      } else if (d.initializer && ts.isArrayLiteralExpression(d.initializer)) {
        out.arrays[name] = d.initializer.elements.map((e) => (ts.isStringLiteral(e) ? e.text : e.getText(sf)));
      }
    }
  }
}

}
for (const [f, tag] of FILES) extract(f, tag);

const json = JSON.stringify(out, null, 2) + '\n';
if (process.argv.includes('--write')) {
  const dest = path.join(root, 'backend', 'tests', 'contracts', 'contracts.golden.json');
  fs.writeFileSync(dest, json);
  console.log(`wrote ${path.relative(root, dest)} (${Object.keys(out.interfaces).length} interfaces, ${Object.keys(out.aliases).length} aliases)`);
} else {
  process.stdout.write(json);
}
