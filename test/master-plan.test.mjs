import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pickReader, planFileMtime } from '../plan/reader.mjs';

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'mplan-'));

const FILE = `---\nupdated: 2026-11-03\n---\n# Cockpit plan\n\n- [x] top item\n\n## Stage 4 (due 2026-11-10)\n\n### Tiles (due 2026-11-05)\n- [x] tests tile #test\n- [~] deployments tile @owner\n  - [!] railway part\n- [ ] agents tile\n\n### Ideas\n- [ ] dark mode for charts\n- [ ] faster scan #bug\n\n## Stage 5\n- [ ] money page\n\n\`\`\`md\n- [ ] not an item\n\`\`\`\n`;
test('master-plan: structure, states, kinds, due, owner, implicit sprints, fences', async () => {
  const d = tmp(); fs.writeFileSync(join(d, 'PLAN.md'), FILE);
  const r = pickReader(d); assert.equal(r.id, 'master-plan');
  const plan = await r.read(d);
  assert.equal(plan.source, 'master-plan');
  assert.deepEqual(plan.milestones.map((m) => [m.id, m.title, m.due]), [['plan#0', 'Cockpit plan', null], ['PLAN.md#1', 'Stage 4', '2026-11-10'], ['PLAN.md#2', 'Stage 5', null]]);
  const s4 = plan.milestones[1];
  assert.deepEqual(s4.sprints.map((s) => [s.id, s.title, s.due, s.items.length]), [['PLAN.md#1.1', 'Tiles', '2026-11-05', 4], ['PLAN.md#1.2', 'Ideas', null, 2]]);
  assert.deepEqual(s4.sprints[0].items.map((i) => [i.title, i.state, i.kind, i.owner]),
    [['tests tile', 'done', 'test', null], ['deployments tile', 'in_progress', 'task', 'owner'], ['railway part', 'blocked', 'task', null], ['agents tile', 'planned', 'task', null]]);
  assert.deepEqual(s4.sprints[1].items.map((i) => i.kind), ['idea', 'bug']);
  assert.equal(plan.milestones[2].sprints[0].id, 'PLAN.md#2#0');
  assert.equal(plan.milestones[0].sprints[0].items[0].id, 'plan#0#0.1');
  // ideas are excluded: 7 counted items (top, 4 Tiles, the #bug in Ideas, money page), 2 done → 29;
  // sprint Tiles 1/4 → 25; Ideas sprint 0/1 (the #bug) → 0; milestone Stage 4 1/5 → 20
  assert.deepEqual([plan.percent, s4.percent, s4.sprints[0].percent, s4.sprints[1].percent], [29, 20, 25, 0]);
  assert.ok(!Number.isNaN(Date.parse(plan.updatedAt)));
});
test('master-plan: a sprint of only ideas counts nothing and does not drag the percentages', async () => {
  const d = tmp(); fs.writeFileSync(join(d, 'PLAN.md'), '## M\n### Work\n- [x] done one\n### Ideas\n- [ ] a\n- [ ] b\n');
  const plan = await pickReader(d).read(d);
  assert.deepEqual([plan.percent, plan.milestones[0].percent, plan.milestones[0].sprints[0].percent, plan.milestones[0].sprints[1].percent], [100, 100, 100, 0]);
});
test('master-plan: CRLF + BOM parse identically; empty file is a plan with no items', async () => {
  const d = tmp(); fs.writeFileSync(join(d, 'PLAN.md'), '\uFEFF' + FILE.replaceAll('\n', '\r\n'));
  const plan = await pickReader(d).read(d);
  assert.equal(plan.percent, 29); assert.equal(plan.milestones.length, 3);
  const e = tmp(); fs.writeFileSync(join(e, 'PLAN.md'), '');
  const empty = await pickReader(e).read(e);
  assert.deepEqual([empty.percent, empty.milestones.length], [0, 0]);
});
test('master-plan wins over checkbox-docs when both exist; planFileMtime prefers PLAN.md', () => {
  const d = tmp(); fs.mkdirSync(join(d, 'docs/superpowers/plans'), { recursive: true });
  fs.writeFileSync(join(d, 'docs/superpowers/plans/a.md'), '# A\n- [ ] x\n'); fs.writeFileSync(join(d, 'PLAN.md'), '# P\n');
  assert.equal(pickReader(d).id, 'master-plan');
  assert.equal(planFileMtime(d), fs.statSync(join(d, 'PLAN.md')).mtimeMs);
  fs.rmSync(join(d, 'PLAN.md'));
  assert.equal(pickReader(d).id, 'checkbox-docs');
  assert.equal(planFileMtime(d), fs.statSync(join(d, 'docs/superpowers/plans/a.md')).mtimeMs);
  assert.equal(planFileMtime(tmp()), null);
});
test('master-plan: Ideas/Backlog/Improvements on milestone or sprint default untagged items to idea', async () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'PLAN.md'), '# P\n## Backlog\n### Misc\n- [ ] x\n## Work\n### improvements\n- [ ] y\n- [ ] z #bug\n### Other\n- [ ] w\n');
  const plan = await pickReader(d).read(d);
  const kinds = plan.milestones.flatMap((m) => m.sprints.flatMap((s) => s.items.map((i) => i.kind)));
  assert.deepEqual(kinds, ['idea', 'idea', 'bug', 'task']);
});
test('master-plan: items with no H1 give a plan#0 milestone titled Plan', async () => {
  const d = tmp(); fs.writeFileSync(join(d, 'PLAN.md'), '- [ ] a\n');
  const plan = await pickReader(d).read(d);
  assert.deepEqual([plan.milestones[0].id, plan.milestones[0].title], ['plan#0', 'Plan']);
});
test('master-plan: frontmatter is skipped (comment is not the title, list item is not an item)', async () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'PLAN.md'), '---\n# frontmatter comment\ntags:\n  - [ ] x\n---\n# Real\n- [ ] a\n');
  const plan = await pickReader(d).read(d);
  assert.equal(plan.milestones.length, 1);
  assert.equal(plan.milestones[0].title, 'Real');
  assert.deepEqual(plan.milestones[0].sprints[0].items.map((i) => i.title), ['a']);
});
