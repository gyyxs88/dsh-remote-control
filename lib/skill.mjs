import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_SKILL_URL = new URL('../skills/dsh-remote-project/SKILL.md', import.meta.url);

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'));
  if (!match) throw new Error(`bundled Skill is missing ${key}`);
  return match[1].trim();
}

export function parseBundledSkill(source, skillPath = fileURLToPath(BUNDLED_SKILL_URL)) {
  const normalized = String(source).replaceAll('\r\n', '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/u);
  if (!match) throw new Error('bundled Skill requires YAML frontmatter and a body');
  const name = frontmatterValue(match[1], 'name');
  const description = frontmatterValue(match[1], 'description');
  const content = match[2].trim();
  if (!name || !description || !content) throw new Error('bundled Skill fields cannot be empty');
  return {
    name,
    description,
    content,
    source: 'bundled',
    provider: 'dsh-remote-control',
    path: skillPath,
    resourceBase: { kind: 'directory', path: path.dirname(skillPath) },
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

export async function loadBundledSkill() {
  return parseBundledSkill(await readFile(BUNDLED_SKILL_URL, 'utf8'), fileURLToPath(BUNDLED_SKILL_URL));
}

export async function registerBundledSkill(ctx) {
  return ctx.skills.register(await loadBundledSkill());
}
