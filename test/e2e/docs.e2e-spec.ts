import { join } from 'path';
import * as ts from 'typescript';

describe('Documentation', () => {
  it('DOC-01 README code examples should compile against the public API', () => {
    const fixture = join(__dirname, '..', 'fixtures', 'readme-examples.ts');
    const program = ts.createProgram([fixture], {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
      noEmit: true,
    });

    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.file?.fileName.endsWith('fixtures/readme-examples.ts'))
      .map(diagnostic => {
        const { line } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        return `line ${line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
      });

    expect(errors).toEqual([]);
  });
});
