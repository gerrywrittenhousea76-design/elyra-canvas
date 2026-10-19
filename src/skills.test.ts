import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS, compileSkill, loadCustomSkills, parseSkill, parseSkillImport, saveCustomSkills, readFavorites, saveFavorites } from './skills';
import { materializeSkill, SkillRunGate, type SkillLaunchDraft, type PendingSkillRun } from './skill-launch';
import { createBlankWorkspace, PROJECT_ID, persistWorkspace, readWorkspace } from './domain';
import { resolveWorkflowRequest } from './workflow-graph';

const storage = () => { const data = new Map<string,string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };
const draft = (): SkillLaunchDraft => ({ skill: BUILTIN_SKILLS[0], values: { product: '香水', scene: '柔和日光' }, model: 'deterministic-mock', transferConsent: false });
const reference = { assetId: 'skill-test-image', width: 640, height: 480, storage: { projectId: PROJECT_ID, blobKey: 'skill-test-image', locator: `indexeddb://elyra-assets/${PROJECT_ID}/skill-test-image` as const, bytes: 300, sha256: 'a'.repeat(64), mimeType: 'image/png' as const, createdAt: '2026-10-10T00:00:00.000Z' } };

describe('declarative Skill catalog', () => {
  it('compiles every built-in with its own fields and frozen version', () => {
    for (const skill of BUILTIN_SKILLS) {
      const values = Object.fromEntries(skill.fields.map(field => [field.key, field.defaultValue || '用户提供的内容']));
      const prompt = compileSkill(skill, values, false);
      expect(prompt).toContain(`${skill.id} v${skill.version}`);
      expect(prompt).not.toMatch(/\{\{/);
    }
  });
  it('rejects missing requirements, long input and forbidden reference', () => {
    expect(() => compileSkill(draft().skill, { product: ' ', scene: '光' }, false)).toThrow('你的产品');
    expect(() => compileSkill(draft().skill, { product: 'a'.repeat(801), scene: '光' }, false)).toThrow();
    expect(() => compileSkill({ ...draft().skill, reference: 'required' }, draft().values, false)).toThrow('参考图');
    expect(() => compileSkill({ ...draft().skill, reference: 'none' }, draft().values, true)).toThrow();
  });
  it('rejects executable fields, unknown variables, duplicate IDs and unsafe cover locations', () => {
    expect(() => parseSkill({ ...BUILTIN_SKILLS[0], script: 'fetch()' })).toThrow();
    expect(() => parseSkill({ ...BUILTIN_SKILLS[0], instructions: '{{missing}}' })).toThrow();
    expect(() => parseSkill({ ...BUILTIN_SKILLS[0], cover: 'javascript:alert(1)' })).toThrow();
    expect(() => parseSkill({ ...BUILTIN_SKILLS[0], cover: '/assets/../../secret.png' })).toThrow();
    expect(() => parseSkill({ ...BUILTIN_SKILLS[0], output: 'video', reference: 'optional' })).toThrow();
    expect(() => parseSkillImport(JSON.stringify(BUILTIN_SKILLS[0]))).toThrow('已存在');
  });
  it('supports 50 saved custom Skills and empty catalog without data loss', () => {
    const target = storage();
    const custom = Array.from({ length: 50 }, (_, i) => ({ ...BUILTIN_SKILLS[0], id: `custom-${i}` }));
    saveCustomSkills(custom, target);
    expect(loadCustomSkills(target).skills).toHaveLength(50);
    saveCustomSkills([], target);
    expect(loadCustomSkills(target)).toEqual({ skills: [] });
    target.setItem('elyra-custom-skills-v1', '{broken');
    expect(loadCustomSkills(target).error).toBeTruthy();
    expect(target.getItem('elyra-custom-skills-v1')).toBe('{broken');
  });
  it('imports atomically and preserves literal user values without recursive expansion', () => {
    const target = storage(); const good = { ...BUILTIN_SKILLS[0], id: 'custom-good' };
    expect(parseSkillImport(JSON.stringify(good))).toEqual([good]);
    expect(() => parseSkillImport(JSON.stringify([good, { ...good, id: 'invalid space' }]))).toThrow();
    expect(target.getItem('elyra-custom-skills-v1')).toBeNull();
    expect(compileSkill(good, { product: '{{scene}}', scene: 'blue' }, false)).toContain('{{scene}}');
  });
  it('persists favorites independently of projects', () => {
    const target = storage(); saveFavorites(['brand-poster'], target);
    expect(readFavorites(target)).toEqual(['brand-poster']);
    expect(target.getItem('elyra-custom-skills-v1')).toBeNull();
  });
  it('enforces the actual Planner limit before materializing a task', () => {
    const long = { ...draft().skill, instructions: 'x'.repeat(3990) + '{{product}}{{scene}}' };
    expect(() => materializeSkill(createBlankWorkspace(), { ...draft(), skill: long }, 'long', PROJECT_ID)).toThrow('4000');
  });
});

describe('Skill to canvas execution boundary', () => {
  it('adds an editable node, preserves existing project and survives save/reopen', () => {
    const before = createBlankWorkspace();
    const first = materializeSkill(before, draft(), 'first', PROJECT_ID);
    const second = materializeSkill(first.workspace, draft(), 'second', PROJECT_ID);
    expect(second.workspace.nodes[0]).toEqual(first.workspace.nodes[0]);
    expect(before.nodes).toHaveLength(0);
    expect(second.workspace.jobs).toEqual(before.jobs);
    expect(resolveWorkflowRequest(second.workspace, second.nodeId).prompt).toBe(second.prompt);
    const target = storage(); persistWorkspace(second.workspace, target, PROJECT_ID);
    const restored = readWorkspace(PROJECT_ID, target);
    expect(restored.status).toBe('ready');
    if (restored.status === 'ready') expect(restored.workspace.nodes[1].workflow?.text).toBe(second.prompt);
    expect(() => materializeSkill(first.workspace, draft(), 'first', PROJECT_ID)).toThrow('重复');
  });
  it('publishes reference, immutable version and connection together', () => {
    const { workspace, nodeId } = materializeSkill(createBlankWorkspace(), { ...draft(), reference }, 'with-reference', PROJECT_ID);
    expect(workspace.nodes).toHaveLength(2); expect(workspace.assets).toHaveLength(1); expect(workspace.versions).toHaveLength(1);
    expect(resolveWorkflowRequest(workspace, nodeId).reference?.assetId).toBe(reference.assetId);
    expect(workspace.jobs).toHaveLength(0);
  });
  it('fails before changing input for cross-project media, missing consent or incompatible model', () => {
    const before = createBlankWorkspace();
    expect(() => materializeSkill(before, { ...draft(), reference: { ...reference, storage: { ...reference.storage, projectId: 'another-project' } } }, 'bad', PROJECT_ID)).toThrow('归属');
    expect(() => materializeSkill(before, { ...draft(), reference, model: 'evolink-gpt-image-2' }, 'bad', PROJECT_ID)).toThrow('确认');
    expect(() => materializeSkill(before, { ...draft(), model: 'evolink-sora-2-preview' }, 'bad', PROJECT_ID)).toThrow('能力');
    expect(before.nodes).toHaveLength(0); expect(before.assets).toHaveLength(0);
  });
  it('claims the explicit launch once, never after reload, expiry or in another project', () => {
    const ticket: PendingSkillRun = { id: 'gesture', projectId: PROJECT_ID, nodeId: 'node', prompt: 'frozen input', model: 'deterministic-mock', transferConsent: false, expiresAt: 500 };
    const gate = new SkillRunGate(); gate.arm(ticket);
    expect(gate.claim(ticket.id, 'other', 100)).toBe(false);
    expect(gate.claim(ticket.id, PROJECT_ID, 100)).toBe(true);
    expect(gate.claim(ticket.id, PROJECT_ID, 100)).toBe(false);
    expect(new SkillRunGate().claim(ticket.id, PROJECT_ID, 100)).toBe(false);
    gate.arm(ticket); expect(gate.claim(ticket.id, PROJECT_ID, 501)).toBe(false);
  });
});
