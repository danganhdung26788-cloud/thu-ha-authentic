import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const WINDOWS_PS51_ENTRYPOINTS = [
  'scripts/windows/Install-WorkflowV2ChatApp.ps1',
  'scripts/windows/Start-WorkflowV2ChatApp.ps1',
  'scripts/windows/Test-AgentV2.ps1',
  'scripts/windows/Test-LocalManagerRouting.ps1',
  'scripts/windows/Register-AgentV2ScheduledTasks.ps1',
] as const;

for (const relativePath of WINDOWS_PS51_ENTRYPOINTS) {
  test(`${relativePath} is ASCII-safe for Windows PowerShell 5.1`, async () => {
    const absolutePath = path.resolve(process.cwd(), relativePath);
    const content = await readFile(absolutePath, 'utf8');
    const nonAscii = [...content].filter((character) => character.codePointAt(0)! > 0x7f);
    assert.deepEqual(
      nonAscii,
      [],
      `${relativePath} contains non-ASCII characters and may be misparsed by Windows PowerShell 5.1 when Git checks it out as UTF-8 without BOM.`,
    );
  });
}
