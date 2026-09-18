// Generate docs/api-reference.md from the TypeScript declarations of the object model (src/api/agent.ts).
// The model-facing API reference is a projection of the code, never a hand-maintained copy (hand-written copies drift).
import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const entries = ['src/api/api.ts', 'src/api/browser.ts', 'src/api/tab.ts'].map((f) => resolve(root, f));
const program = ts.createProgram(entries, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, noEmit: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
});
const checker = program.getTypeChecker();
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.WriteArrayAsGenericType;

const doc = (sym) => { const parts = sym?.getDocumentationComment?.(checker) ?? []; return ts.displayPartsToString(parts).replace(/\s+/g, ' ').trim(); };
let sf; // current source file while scanning
const fmtType = (t) => checker.typeToString(t, undefined, FLAGS);
const sigText = (sig) => {
  const params = sig.getParameters().map((p) => {
    const d = p.valueDeclaration; const optional = d && ts.isParameter(d) && (d.questionToken || d.initializer) ? '?' : '';
    const t = fmtType(checker.getTypeOfSymbolAtLocation(p, d ?? sf));
    return `${p.getName()}${optional}: ${optional ? t.replace(/ \| undefined$/, '') : t}`;
  });
  return `(${params.join(', ')}): ${fmtType(sig.getReturnType())}`;
};
/** One member line: methods as signatures, object-valued properties expanded one level, everything else as a type. */
function memberLines(type, indent, depth) {
  const out = [];
  for (const m of checker.getPropertiesOfType(type)) {
    const name = m.getName();
    if (name.startsWith('_') || name === 'constructor' || name === 'use') continue; // `use` is runtime plumbing, not model surface
    const decl = m.valueDeclaration ?? m.declarations?.[0];
    if (decl && ts.canHaveModifiers(decl) && ts.getModifiers(decl)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) continue;
    const t = checker.getTypeOfSymbolAtLocation(m, decl ?? sf);
    const sigs = t.getCallSignatures();
    const comment = doc(m);
    if (sigs.length) { for (const s of sigs) out.push(`${indent}${name}${sigText(s)};${comment ? ` // ${comment}` : ''}`); continue; }
    const props = checker.getPropertiesOfType(t);
    const isObj = props.length && !t.isUnion() && (t.flags & ts.TypeFlags.Object) && !(t.symbol?.name === 'Promise') && !(t.symbol?.name === 'Map') && !(t.symbol?.name === 'Set') && depth < 2 && !['string', 'number', 'boolean'].includes(fmtType(t));
    if (isObj && props.some((p) => checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? sf).getCallSignatures().length)) {
      out.push(`${indent}${name}: {${comment ? ` // ${comment}` : ''}`);
      out.push(...memberLines(t, indent + '  ', depth + 1));
      out.push(`${indent}};`);
    } else { const opt = m.flags & ts.SymbolFlags.Optional; out.push(`${indent}${name}${opt ? '?' : ''}: ${opt ? fmtType(t).replace(/ \| undefined$/, '') : fmtType(t)};${comment ? ` // ${comment}` : ''}`); }
  }
  return out;
}
const sections = [];
const wanted = new Map([['AgentApi', 'interface'], ['Browser', 'class'], ['Tab', 'class']]);
const aliases = ['Target', 'ActAction', 'ActOptions', 'ObserveOptions'];
for (const entry of entries) { sf = program.getSourceFile(entry); ts.forEachChild(sf, (node) => {
  if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && wanted.has(node.name.text)) {
    const sym = checker.getSymbolAtLocation(node.name);
    const type = ts.isClassDeclaration(node) ? checker.getDeclaredTypeOfSymbol(sym) : checker.getTypeAtLocation(node);
    const head = doc(sym);
    sections.push(`${head ? `// ${head}\n` : ''}${wanted.get(node.name.text)} ${node.name.text} {\n${memberLines(type, '  ', 0).join('\n')}\n}`);
  }
  if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && aliases.includes(node.name.text)) {
    sections.push(node.getText(sf).replace(/\s*\/\*\*[^*]*\*\/\s*/g, ' ').replace(/\n\s+/g, '\n  '));
  }
}); }
// keep a stable order: the entry object first, then Browser, Tab, then the value types
const order = ['interface AgentApi', 'class Browser', 'class Tab', 'type Target', 'type ActAction', 'interface ActOptions', 'interface ObserveOptions'];
const key = (s) => s.replace(/^\/\/.*\n/, '').replace(/^export /, '');
sections.sort((a, b) => order.findIndex((k) => key(a).startsWith(k)) - order.findIndex((k) => key(b).startsWith(k)));
// `?` already says undefined for parameters (also inside type-literal method signatures); real `T | undefined` results and properties stay
const clean = (s) => s.replace(/^export /gm, '').replace(/ \| undefined(?=[,)])/g, '');
const md = `## API reference (generated from src/api/{api,browser,tab}.ts — do not edit)

In \`js\` the globals are \`agent\`, \`sites\`, \`recon\`, \`tools\`, \`session\` (the members of \`AgentApi\`) plus \`nodeRepl\` and \`Tab\`. Everything below is the whole model-facing surface; typed entry tools are projections of it.

\`\`\`ts
${sections.map(clean).join('\n\n')}
\`\`\`
`;
writeFileSync(resolve(root, 'docs/api-reference.md'), md);
console.log(`api reference → docs/api-reference.md (${md.length} chars, ${sections.length} declarations)`);
