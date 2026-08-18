# Criando um time

Um time é um grupo de agentes que compartilham um objetivo, um workspace e um
orquestrador. Este documento explica como criá-lo, o que decidir no caminho, e
onde o arquivo `.yaml` do time é gravado.

- [O que é um time](#o-que-é-um-time)
- [A pasta `teams/`](#a-pasta-teams)
- [Três formas de criar](#três-formas-de-criar)
- [As cinco decisões que importam](#as-cinco-decisões-que-importam)
- [Anatomia do arquivo](#anatomia-do-arquivo)
- [Checklist antes de rodar](#checklist-antes-de-rodar)
- [Erros comuns](#erros-comuns)

O **esquema completo** do formato está em [`team-format.md`](./team-format.md).
Este documento é o guia; aquele é a referência.

---

## O que é um time

```
Team: Engineering                    workspace: ~/projects/my-app
├── architect   Opus    high    ← orquestrador
├── backend     Sonnet  medium
├── frontend    Sonnet  medium
├── qa          Sonnet  high
└── reviewer    Opus    high
```

Um time define **quem existe e o que cada um pode fazer**. Ele não define as
tarefas: essas nascem em tempo de execução, quando o orquestrador recebe o
objetivo e chama `create_tasks`. Por isso o mesmo time serve para objetivos
diferentes.

Cada agente carrega a própria configuração — modelo, esforço de raciocínio,
prompt, permissões, com quem pode falar, limites. Nada é herdado do
orquestrador em tempo de execução.

---

## A pasta `teams/`

**Todo time é gravado como YAML automaticamente.** Você não precisa exportar
nada à mão.

```
~/.claude-team/
    claude-team.db                        ← estado (não versione)
    teams/
        engineering.tm_a1b2c3d4.yaml      ← seu time (versione à vontade)
        longtail-marketing.tm_e5f6g7.yaml
```

O arquivo é regravado sempre que a forma do time muda: criar ou remover o time,
adicionar, editar, duplicar ou remover um agente, trocar modelo, esforço,
permissões, `canMessage`, orquestrador, workspace ou budget. Renomear o time
renomeia o arquivo e apaga o antigo; apagar o time apaga o arquivo.

Para importar em outra máquina:

```bash
claude-team team import ~/.claude-team/teams/engineering.tm_a1b2c3d4.yaml
```

### Apontando para o seu repositório

Se você quer versionar os times junto com o projeto, mude o destino em
**Settings → Teams folder** (ou via API, `teamsDir`). Ao mudar, a pasta nova é
populada na hora com todos os times existentes.

```
~/projects/my-app/team/engineering.tm_a1b2c3d4.yaml
```

### É espelho, não fonte da verdade

O banco manda. Editar o `.yaml` na pasta **não muda nada** até você rodar
`team import` — e o import cria um time novo, não sobrescreve o existente.

Isso é deliberado: o auto-save do seu editor não deve reconfigurar um time que
está no meio de um run. Se a gravação falhar (disco cheio, pasta somente
leitura), a operação que você pediu continua valendo e você recebe um aviso — o
arquivo é conveniência, não é o dado.

---

## Três formas de criar

### 1. Pelo wizard (mais rápido para começar)

```bash
claude-team          # TUI
pnpm web             # navegador
```

Escolha um preset, confirme **modelo e esforço de cada agente
individualmente**, revise permissões, defina o workspace. O time nasce
completo e editável — o preset é ponto de partida, não molde fixo.

Presets que já vêm: Software Engineering, Research, Product, Review Board,
Solo Agent.

### 2. Por arquivo YAML (melhor para versionar)

Escreva o arquivo e importe:

```bash
claude-team team import meu-time.yaml
```

É o caminho certo quando você quer prompts próprios, quer revisar o time em
pull request, ou quer o mesmo time em várias máquinas. Há um exemplo completo e
comentado em [`../examples/teams/longtail-marketing.yaml`](../examples/teams/longtail-marketing.yaml).

### 3. Como preset embutido (quando é para todo mundo)

Só vale a pena se o time deve aparecer no wizard para todos os usuários. São
dois arquivos:

**`packages/domain/src/templates.ts`** — um `AgentTemplate` por papel:

```ts
{
  id: 'seo-researcher',
  handle: 'pesquisa',
  name: 'Pesquisa de Palavras-chave',
  role: 'SEO / Keyword Researcher',
  category: 'research',
  description: 'Encontra termos de cauda longa que valem a pena.',
  model: DEFAULT_MODEL,
  effort: 'medium',
  tools: permissionsFromGroups(['filesystem_read', 'filesystem_write', 'network', 'agent_messaging']),
  communicationRules: 'Sempre cite a fonte de cada número.',
  systemPrompt: prompt([ /* ... */ ]),
}
```

**`packages/domain/src/presets.ts`** — o time e a fiação entre os papéis:

```ts
{
  id: 'longtail-marketing',
  name: 'Longtail Marketing',
  description: 'Pauta, pesquisa de cauda longa, produção e revisão.',
  members: [
    { templateId: 'content-head',   handle: 'head',      orchestrator: true, effort: 'high', canMessage: ['*'] },
    { templateId: 'seo-researcher', handle: 'pesquisa',  canMessage: ['head', 'estrategia', 'redacao'] },
    // ...
  ],
}
```

Não há lista duplicada em lugar nenhum: `core.listPresets()` resolve cada
membro para o handle, modelo e esforço concretos, e as duas interfaces leem
disso. O preset aparece sozinho no wizard da TUI e da Web.

---

## As cinco decisões que importam

Um time ruim quase sempre erra uma destas.

### 1. Quem orquestra

O orquestrador recebe o objetivo, quebra em tarefas, delega e sintetiza o
resultado. Ele **não** executa o trabalho. Escolha o papel que naturalmente
decide — arquiteto, tech lead, head de conteúdo, PM — e dê a ele o modelo mais
capaz do time. É a única posição onde economizar sai caro: um plano ruim
desperdiça o trabalho de todo o resto.

Se você não indicar `orchestrator`, o primeiro agente da lista assume.

### 2. Modelo e esforço por papel

| Situação | Sugestão |
| --- | --- |
| Decide, projeta, revisa | modelo mais forte, `high` ou `max` |
| Implementa a partir de um briefing claro | modelo intermediário, `medium` |
| Trabalho mecânico ou de alto volume | modelo rápido, `low`/`medium` |
| Última barreira antes de publicar/mergear | modelo forte, `high` |

Um time inteiro em `max` é caro e mais lento sem ser proporcionalmente melhor.
Um time inteiro em `low` produz volume que alguém terá de refazer.

### 3. O grafo de comunicação (`can_message`)

Isto é desenho organizacional, não detalhe técnico. `['*']` significa "fala com
todo mundo" e é o certo para o orquestrador. Para os demais, restrinja ao que
faz sentido:

```yaml
analise:
  can_message: [head, estrategia]   # analista não manda redator reescrever
```

Restringir reduz conversa cruzada, reduz custo e torna a timeline legível.
O runtime recusa entregas fora do grafo e registra a recusa.

### 4. Permissões

Agentes recebem **grupos de capacidade**, cada um `allow`, `ask` ou `deny`:

`filesystem_read` · `filesystem_write` · `terminal` · `git` · `network` ·
`browser` · `mcp` · `agent_messaging`

Isto não é sugestão de prompt — em `deny` a ferramenta não é sequer entregue ao
agente. Um time de conteúdo não tem por que ter `terminal`. Um revisor não
precisa de `filesystem_write`.

Cuidado com um caso específico: **git roda através do shell**. `git: allow` com
`terminal: deny` resulta em comandos `git ...` permitidos e todo o resto
recusado — é o comportamento desejado, mas vale saber que os dois interagem.

Grupo não declarado usa o padrão da capacidade (`filesystem_read` é `allow`,
`filesystem_write` é `ask`, `browser` é `deny`), **não** `deny` para tudo.

#### O que o time herda da sua máquina

Por padrão, **nada** da sua configuração local do Claude Code: nem a sua memória
(`CLAUDE.md`), nem as suas skills, nem os seus servidores MCP. É o que faz o
arquivo do time se comportar igual em qualquer máquina. A sua conta continua
sendo usada — isto é sobre configuração, não sobre credencial.

Em **Settings → Your local Claude Code** (web) ou **Settings → Local Claude
Code** (TUI) você liga isso, por partes: memória, skills (todas ou uma lista) e
MCP. Vale para o próximo run, não é preciso reiniciar.

Duas consequências que valem antes de ligar:

- o seu `~/.claude/settings.json` pode **pré-aprovar ferramentas**, e essas
  chamadas passam sem o gate de permissão deste produto (as capacidades em
  `deny` continuam recusadas);
- o time deixa de ser portátil — quem importar o YAML em outra máquina não tem
  as suas skills.

### 5. Revisão é por tarefa, não por time

Não existe campo "reviewer" no arquivo do time. A revisão é atribuída pelo
orquestrador ao criar a tarefa (`create_tasks({ reviewer: 'revisao' })`), e o
revisor precisa terminar com `VERDICT: APPROVED` ou `VERDICT: CHANGES_REQUESTED`.

Ou seja: ter um agente revisor no time **não garante** que ele será usado.
Escreva isso no prompt do orquestrador:

```yaml
head:
  system_prompt: |
    Toda tarefa de redação DEVE ser criada com `reviewer: revisao`.
    Nada é publicado sem revisão.
```

---

## Anatomia do arquivo

```yaml
version: 1
name: Longtail Marketing
workspace: ~/projects/conteudo
orchestrator: head            # handle, não id

budget:                       # opcional, mas recomendado
  maxCostUsd: 15
  maxDurationMinutes: 45
  maxAgentActivations: 40

agents:
  head:                       # a chave é o handle: como os outros o chamam
    name: Head de Conteúdo
    role: Head de Conteúdo
    model: opus
    effort: high
    system_prompt: |
      Você é o Head de Conteúdo...
    communication_rules: |
      Responda rápido: o time trava esperando você.
    tools:
      filesystem_read: allow
      filesystem_write: ask
      network: allow
      terminal: deny
      agent_messaging: allow
    can_message: ['*']
    limits:
      maxTurns: 25
      timeoutMs: 900000
```

Obrigatórios: `name`, `agents`, e `role` em cada agente. Todo o resto tem
padrão sensato.

Os handles são o vocabulário do time: é por eles que os agentes se chamam nas
mensagens e que o orquestrador atribui tarefas. Prefira curtos e óbvios
(`backend`, `revisao`) a descritivos (`engenheiro-de-backend-senior`).

---

## Checklist antes de rodar

- [ ] O orquestrador está definido e **não** é quem executa o trabalho?
- [ ] Cada agente tem um papel que alguém reconheceria como um cargo real?
- [ ] Os modelos e esforços variam conforme a responsabilidade?
- [ ] Alguém consegue chegar em todo mundo que precisa? (o orquestrador com `['*']` resolve)
- [ ] As permissões são o mínimo necessário — sem `terminal` para quem não precisa?
- [ ] Se há revisor, o prompt do orquestrador manda usá-lo?
- [ ] O `workspace` aponta para uma pasta que existe?
- [ ] Há budget?

Depois, teste sem gastar nada:

```bash
claude-team --provider fake run "um objetivo de teste" --team "Meu Time"
```

O provider determinístico executa o fluxo inteiro — DAG de tarefas, delegação,
mensagens entre agentes, revisão — sem chamar modelo nenhum. Serve para
verificar que a fiação do time está certa antes de gastar tokens.

---

## Erros comuns

**O run termina sem fazer nada.** Quase sempre o orquestrador não tem com quem
falar (`can_message` restrito demais) ou os agentes estão sem permissão para
agir. Ambos aparecem na timeline do run.

**O revisor nunca é chamado.** Falta a instrução no prompt do orquestrador —
veja a decisão 5 acima.

**O time conversa muito e produz pouco.** Grafo `['*']` para todo mundo. Feche o
grafo: só o orquestrador precisa de acesso total.

**Custo alto demais.** Confira quantos agentes estão em `high`/`max` e no modelo
mais caro. O snapshot no topo de cada run mostra exatamente com que configuração
cada agente rodou.

**Editei o YAML na pasta `teams/` e nada mudou.** É espelho. Rode
`claude-team team import <arquivo>` — lembrando que isso cria um time novo.

**"native binary … failed to launch" ao iniciar o run.** A mensagem do SDK fala
em libc, mas no macOS a causa quase sempre é outra: o `workspace` aponta para
uma pasta que não existe. O agente é lançado com ela como `cwd`, o spawn falha
com `ENOENT`, e o SDK atribui isso ao binário. O run agora recusa antes disso,
dizendo qual caminho e de quem é — crie a pasta ou mude o workspace.

**YAML inválido no import.** O erro aponta linha e coluna. O caso mais comum é
dois-pontos dentro de um texto sem aspas:

```yaml
description: Briefing: ângulo e estrutura      # quebra
description: 'Briefing: ângulo e estrutura'    # correto
```
