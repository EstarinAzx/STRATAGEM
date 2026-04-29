import { dirname, join } from 'path'

export const PRIMARY_PROJECT_INSTRUCTION_FILE = 'STRATAGEM.md'
export const SECONDARY_PROJECT_INSTRUCTION_FILE = 'AGENTS.md'
export const LEGACY_PROJECT_INSTRUCTION_FILE = 'CLAUDE.md'

export function getProjectInstructionFilePaths(dir: string): string[] {
  return [
    join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE),
    join(dir, SECONDARY_PROJECT_INSTRUCTION_FILE),
    join(dir, LEGACY_PROJECT_INSTRUCTION_FILE),
  ]
}

export function getProjectInstructionFilePath(
  dir: string,
  existsSync: (path: string) => boolean,
): string {
  const paths = getProjectInstructionFilePaths(dir)
  // Return the first file that exists, or the primary (STRATAGEM.md) as default
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return paths[0]
}

export function hasProjectInstructionFile(
  dir: string,
  existsSync: (path: string) => boolean,
): boolean {
  return getProjectInstructionFilePaths(dir).some(path => existsSync(path))
}

export function findProjectInstructionFilePathInAncestors(
  startDir: string,
  existsSync: (path: string) => boolean,
): string | null {
  let currentDir = startDir

  while (true) {
    if (hasProjectInstructionFile(currentDir, existsSync)) {
      return getProjectInstructionFilePath(currentDir, existsSync)
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }

    currentDir = parentDir
  }
}

export function isProjectInstructionFileName(name: string): boolean {
  return (
    name === PRIMARY_PROJECT_INSTRUCTION_FILE ||
    name === SECONDARY_PROJECT_INSTRUCTION_FILE ||
    name === LEGACY_PROJECT_INSTRUCTION_FILE
  )
}
