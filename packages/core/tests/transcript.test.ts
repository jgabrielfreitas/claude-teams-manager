import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';
import { TRANSCRIPT_FORMATS } from '../src/transcript.js';

/**
 * The exported transcript is an artefact people paste into issues and share, so
 * it has to be complete and identical whichever surface produced it.
 */

const ANSWER = 'is blocked waiting on your answer';

async function runOnce(): Promise<{ app: AppCore; runId: string }> {
  const provider = new FakeAgentProvider({
    behaviors: {
      architect: (ctx: { input: { prompt: string } }) => {
        if (ctx.input.prompt.includes(ANSWER)) {
          return [{ kind: 'text', text: 'Use Redis, and write the decision down.' }] as FakeStep[];
        }
        if (ctx.input.prompt.includes('Round')) {
          return [
            { kind: 'tool', tool: 'finish', args: { summary: 'Auth shipped and reviewed.' } },
          ] as FakeStep[];
        }
        return [
          {
            kind: 'tool',
            tool: 'create_tasks',
            args: {
              tasks: [
                { key: 'api', title: 'Build the auth API', assignee: 'backend' },
                {
                  key: 'ui',
                  title: 'Build the login screen',
                  assignee: 'frontend',
                  dependsOn: ['api'],
                  reviewer: 'reviewer',
                },
              ],
            },
          },
        ] as FakeStep[];
      },
      backend: () =>
        [
          {
            kind: 'tool',
            tool: 'ask_agent',
            args: { to: 'architect', question: 'Redis or Postgres for sessions?' },
          },
          { kind: 'text', text: 'Auth API done; sessions in Redis.' },
        ] as FakeStep[],
      frontend: () => [{ kind: 'text', text: 'Login screen wired up.' }] as FakeStep[],
      reviewer: () => [{ kind: 'text', text: 'Looks right.\nVERDICT: APPROVED' }] as FakeStep[],
    } as never,
  });

  const app = new AppCore({ storage: new InMemoryStorage(), provider });
  await app.init();
  const team = await app.createTeamFromPreset({
    presetId: 'software-engineering',
    name: 'Engineering',
  });
  const run = await app.startRun({ teamId: team.id, objective: 'Build authentication' });
  await app.waitForRun(run.id);
  return { app, runId: run.id };
}

describe('run transcript', () => {
  it('contains everything needed to understand the run, in markdown', async () => {
    const { app, runId } = await runOnce();
    const { content, fileName, mimeType, format } = await app.exportRun(runId, {
      format: 'markdown',
    });

    expect(format).toBe('markdown');
    expect(mimeType).toContain('text/markdown');
    expect(fileName).toMatch(new RegExp(`^run-${runId}-.*\\.md$`));

    // Header and totals
    expect(content).toContain(`# Run ${runId}`);
    expect(content).toContain('Build authentication');
    expect(content).toContain('| Team | Engineering |');
    expect(content).toContain('| Status | **completed** |');

    // Per-agent configuration actually used — the point of the whole product.
    expect(content).toContain('## Agents');
    expect(content).toContain('*(orchestrator)*');
    expect(content).toMatch(/architect.*Opus.*High/);
    expect(content).toMatch(/backend.*Sonnet.*Medium/);

    // Tasks with their dependency and review wiring, plus results
    expect(content).toContain('### Build the auth API');
    expect(content).toContain('reviewed by **reviewer**');
    expect(content).toContain('after: Build the auth API');
    expect(content).toContain('Auth API done; sessions in Redis.');

    // The conversation, both directions
    expect(content).toContain('## Messages');
    expect(content).toContain('Redis or Postgres for sessions?');
    expect(content).toContain('Use Redis, and write the decision down.');

    // The timeline and the result
    expect(content).toContain('## Timeline');
    expect(content).toContain('## Result');
    expect(content).toContain('Auth shipped and reviewed.');

    await app.shutdown();
  }, 30_000);

  it('produces every format, each non-trivial and self-describing', async () => {
    const { app, runId } = await runOnce();

    for (const format of TRANSCRIPT_FORMATS) {
      const result = await app.exportRun(runId, { format });
      expect(result.format).toBe(format);
      expect(result.content.length).toBeGreaterThan(400);
      expect(result.content).toContain(runId);
      expect(result.fileName.startsWith(`run-${runId}-`)).toBe(true);
    }

    const json = JSON.parse((await app.exportRun(runId, { format: 'json' })).content);
    expect(json.run.status).toBe('completed');
    expect(json.tasks).toHaveLength(2);
    expect(json.messages.length).toBeGreaterThan(0);
    // Per-agent accounting is derived, not stored — it must survive the export.
    const backend = json.perAgent.find((a: { handle: string }) => a.handle === 'backend');
    expect(backend.activations).toBeGreaterThan(0);
    expect(backend.model).toBe('sonnet');

    await app.shutdown();
  }, 30_000);

  it('hides debug noise by default and includes it on request', async () => {
    const { app, runId } = await runOnce();

    const quiet = await app.exportRun(runId, { format: 'text' });
    const verbose = await app.exportRun(runId, { format: 'text', includeDebug: true });

    expect(verbose.content.length).toBeGreaterThan(quiet.content.length);
    expect(quiet.content).not.toContain('is thinking');
    expect(verbose.content).toContain('is thinking');

    await app.shutdown();
  }, 30_000);

  it('can leave the message bodies out', async () => {
    const { app, runId } = await runOnce();
    const withMessages = await app.exportRun(runId, { format: 'markdown' });
    const without = await app.exportRun(runId, { format: 'markdown', includeMessages: false });

    expect(withMessages.content).toContain('## Messages');
    expect(without.content).not.toContain('## Messages');
    expect(without.content.length).toBeLessThan(withMessages.content.length);

    // The timeline still records that the exchange happened — dropping the
    // bodies must not erase the fact, only the transcript of it.
    expect(without.content).toContain('## Timeline');
    expect(without.content).toMatch(/architect answered backend/i);

    // The answer's full body is gone from the JSON export too.
    const json = JSON.parse(
      (await app.exportRun(runId, { format: 'json', includeMessages: false })).content,
    );
    expect(json.messages).toEqual([]);

    await app.shutdown();
  }, 30_000);

  it('records the decisions the human was asked for, and what they answered', async () => {
    const provider = new FakeAgentProvider({
      behaviors: {
        assistant: [
          {
            kind: 'tool',
            tool: 'ask_user',
            args: {
              header: 'Niche',
              question: 'Which niche should the page target?',
              options: [
                { label: 'Weddings', description: 'High ticket, seasonal' },
                { label: 'Home office', description: 'Steady, competitive' },
              ],
            },
          },
          { kind: 'tool', tool: 'finish', args: { summary: 'Planned around the chosen niche.' } },
        ],
      } as never,
    });
    const app = new AppCore({ storage: new InMemoryStorage(), provider });
    await app.init();
    app.subscribe((event) => {
      if (event.type === 'question' && event.question.status === 'pending') {
        void app.answerQuestion({ questionId: event.question.id, selected: ['Weddings'] });
      }
    });

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Plan a longtail page' });
    await app.waitForRun(run.id);

    const markdown = (await app.exportRun(run.id, { format: 'markdown' })).content;
    expect(markdown).toContain('## Decisions you were asked for');
    expect(markdown).toContain('### Niche');
    expect(markdown).toContain('Which niche should the page target?');
    expect(markdown).toContain('High ticket, seasonal');
    expect(markdown).toContain('Chosen: Weddings');
    // The timeline says it plainly too, rather than calling it an approval.
    expect(markdown).toContain('is asking you');
    expect(markdown).not.toMatch(/approval/i);

    const text = (await app.exportRun(run.id, { format: 'text' })).content;
    expect(text).toContain('DECISIONS YOU WERE ASKED FOR');

    const json = JSON.parse((await app.exportRun(run.id, { format: 'json' })).content);
    expect(json.questions).toHaveLength(1);
    expect(json.questions[0].status).toBe('answered');

    await app.shutdown();
  }, 30_000);

  it('exports a run that failed, including the failure', async () => {
    const provider = new FakeAgentProvider({
      behaviors: { assistant: () => [{ kind: 'fail', message: 'provider exploded' }] } as never,
    });
    const app = new AppCore({ storage: new InMemoryStorage(), provider });
    await app.init();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Something doomed' });
    await app.waitForRun(run.id);

    const { content } = await app.exportRun(run.id, { format: 'markdown' });
    expect(content).toContain('Something doomed');
    expect(content).toContain('provider exploded');

    await app.shutdown();
  }, 30_000);
});
