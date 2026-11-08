import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pickReader } from '../plan/reader.mjs';

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'plan-'));

test('checkbox-docs: milestone per file, sprint per task heading, items from checkboxes', async () => {
  const d = tmp();
  fs.mkdirSync(join(d, 'docs/superpowers/plans'), { recursive: true });
  fs.writeFileSync(join(d, 'docs/superpowers/plans/a.md'),
    '# Alpha\n\nintro\n\n### Task 1: x\n- [x] one\n- [ ] two\n\n### Task 2: y\n- [ ] fix the bug\n');
  const reader = pickReader(d);
  assert.equal(reader.id, 'checkbox-docs');
  const plan = await reader.read(d);
  assert.equal(plan.source, 'checkbox-docs');
  assert.equal(plan.milestones.length, 1);
  assert.equal(plan.milestones[0].title, 'Alpha');
  assert.equal(plan.milestones[0].due, null);
  assert.equal(plan.milestones[0].sprints.length, 2);
  assert.equal(plan.milestones[0].percent, 33);
  assert.equal(plan.percent, 33);
  assert.equal(plan.milestones[0].sprints[0].percent, 50);
  const [one, two] = plan.milestones[0].sprints[0].items;
  assert.deepEqual([one.state, one.kind, two.state, two.kind], ['done', 'task', 'planned', 'task']);
  assert.equal(plan.milestones[0].sprints[1].items[0].kind, 'bug');
  assert.ok(!Number.isNaN(Date.parse(plan.updatedAt)));
});

test('file under ideas/backlog gives idea items; no checkboxes gives 0 percent', async () => {
  const d = tmp();
  fs.mkdirSync(join(d, 'docs/plans/backlog'), { recursive: true });
  fs.writeFileSync(join(d, 'docs/plans/backlog/b.md'), '# Later\n## Things\n- [ ] maybe this\n');
  fs.writeFileSync(join(d, 'docs/plans/empty.md'), '# Empty\n## S\nno boxes\n');
  const plan = await pickReader(d).read(d);
  const byTitle = Object.fromEntries(plan.milestones.map((m) => [m.title, m]));
  assert.equal(byTitle.Later.sprints[0].items[0].kind, 'idea');
  assert.equal(byTitle.Empty.percent, 0);
});

test('home without plans: pickReader is null', () => {
  assert.equal(pickReader(tmp()), null);
});

test('checkbox-docs: inline markdown is stripped from titles', async () => {
  const d = tmp();
  fs.mkdirSync(join(d, 'docs/superpowers/plans'), { recursive: true });
  fs.writeFileSync(join(d, 'docs/superpowers/plans/b.md'),
    '# **Big** plan\n\n### Task `1`: [site](http://x)\n- [ ] **bold** and [link](x)\n');
  const plan = await pickReader(d).read(d);
  assert.equal(plan.milestones[0].title, 'Big plan');
  assert.equal(plan.milestones[0].sprints[0].title, 'Task 1: site');
  assert.equal(plan.milestones[0].sprints[0].items[0].title, 'bold and link');
});

test('plainTitle strips only paired emphasis', async () => {
  const { plainTitle } = await import('../plan/checkbox-docs.mjs');
  assert.equal(plainTitle('2*3 ways'), '2*3 ways');
  assert.equal(plainTitle('Fix `__init__` import'), 'Fix __init__ import');
  assert.equal(plainTitle('**bold** and _x_'), 'bold and _x_');
  assert.equal(plainTitle('a *b* [c](http://x)'), 'a b c');
});
