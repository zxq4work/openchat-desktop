#!/usr/bin/env node
/**
 * OpenChat Desktop — Mock App Server
 *
 * 开发专用，模拟 Codex App Server 0.148.0 的 JSONL stdin/stdout transport。
 * 与 AppServerProcess 使用完全相同的传输协议。
 *
 * 实现：
 *   initialize
 *   account/read
 *   account/login/start
 *   account/login/cancel
 *   account/logout
 *   model/list
 *   thread/start
 *   thread/resume
 *   thread/delete
 *   turn/start
 *   turn/interrupt
 *
 * 模拟通知：
 *   account/login/completed
 *   account/updated
 *   thread/started
 *   turn/started
 *   item/started
 *   item/agentMessage/delta
 *   item/completed
 *   turn/completed
 *
 * 记录能力（供测试断言）：
 *   turn/start 记录收到的 model 和 effort
 *   thread/start 记录 developerInstructions
 */

import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

// ===== 随机回复生成 =====
const REPLY_TEMPLATES = [
  () => {
    const greetings = ['你好！', '嗨！', '您好！', '哈喽！']
    const names = ['OpenChat Mock', 'Mock 助手', 'Codex 模拟', 'AI 测试']
    return `${greetings[Math.floor(Math.random() * greetings.length)]}我是 ${names[Math.floor(Math.random() * names.length)]}。\n\n这是一个用于开发测试的模拟回复。[${Math.random().toString(36).slice(2, 8)}]`
  },
  () => {
    const topics = ['关于编程', '关于设计', '关于测试', '关于开发流程']
    const tips = ['保持代码简洁', '多写测试', '善用工具', '关注性能', '重视安全']
    return `在${topics[Math.floor(Math.random() * topics.length)]}方面，我建议：${tips[Math.floor(Math.random() * tips.length)]}。\n\n\`\`\`javascript\nconst tip = "${tips[Math.floor(Math.random() * tips.length)]}";\nconsole.log(\`今日建议: \${tip}\`);\nconsole.log("ID: ${Math.random().toString(36).slice(2, 10)}");\n\`\`\``
  },
  () => {
    const items = ['需求分析', '架构设计', '编码实现', '测试验证', '部署上线', '运维监控']
    const picked = items.sort(() => Math.random() - 0.5).slice(0, 3)
    return `我建议按以下顺序推进工作：\n\n1. ${picked[0] || '需求分析'}\n2. ${picked[1] || '编码实现'}\n3. ${picked[2] || '测试验证'}\n\n\`\`\`python\ndef process():\n    steps = ${JSON.stringify(picked)}\n    for step in steps:\n        print(f"执行: {step}")\n    return "完成 [${Math.random().toString(36).slice(2, 6)}]"\n\`\`\``
  },
  () => {
    const emoji = ['✓', '⚡', '★', '♦', '►']
    return `收到你的消息了 ${emoji[Math.floor(Math.random() * emoji.length)]}\n\n当前模型：MODEL_PLACEHOLDER\n推理强度：EFFORT_PLACEHOLDER\n\n这是一条模拟回复，每次内容都不同。\n\n> 随机引用块 [${Math.random().toString(36).slice(2, 8)}]`
  },
  () => {
    return `让我来分析一下这个问题。\n\n### 分析\n\n这个问题涉及多个方面，我们需要逐一考虑。\n\n\`\`\`typescript\ninterface Analysis {\n  id: string;\n  score: number;\n  summary: string;\n}\n\nconst result: Analysis = {\n  id: "${Math.random().toString(36).slice(2, 10)}",\n  score: ${Math.floor(Math.random() * 100)},\n  summary: "这是一个模拟分析结果",\n};\n\`\`\`\n\n希望这个分析对你有所帮助！`
  },
]
const MODELS = [
  // A. low/medium/high
  {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT-5.6-Sol',
    description: 'Fast general-purpose model with low/medium/high reasoning',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
      { reasoningEffort: 'medium', description: 'Balanced reasoning' },
      { reasoningEffort: 'high', description: 'Deep reasoning' },
    ],
    defaultReasoningEffort: 'low',
    inputModalities: ['text'],
    supportsPersonality: true,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
  // B. none/low/high/xhigh/max
  {
    id: 'gpt-5.6-terra',
    model: 'gpt-5.6-terra',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT-5.6-Terra',
    description: 'Extended reasoning range model',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'none', description: 'No reasoning' },
      { reasoningEffort: 'low', description: 'Fast responses' },
      { reasoningEffort: 'high', description: 'Deep reasoning' },
      { reasoningEffort: 'xhigh', description: 'Very deep reasoning' },
      { reasoningEffort: 'max', description: 'Maximum reasoning' },
    ],
    defaultReasoningEffort: 'none',
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
  // C. supportedReasoningEfforts 为空
  {
    id: 'gpt-5.6-lite',
    model: 'gpt-5.6-lite',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT-5.6-Lite',
    description: 'No reasoning effort support',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'none',
    inputModalities: ['text'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
]

// ===== 状态 =====
const state = {
  initialized: false,
  loggedIn: true,  // Mock 默认已登录
  email: 'mock@openchat.local',
  planType: 'plus',
  pendingLoginId: null,
  threads: new Map(), // threadId -> { id, developerInstructions, model }
  turns: new Map(), // turnId -> { threadId, model, effort }
}

// ===== 记录能力（供测试断言） =====
const recorded = {
  turnStarts: [], // [{ threadId, model, effort }]
  threadStarts: [], // [{ threadId, model, developerInstructions }]
}

// ===== 输出 =====
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

// ===== RPC 处理 =====
function handleRequest(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      state.initialized = true
      sendResult(id, {
        userAgent: 'codex/0.148.0',
        codexHome: '/tmp/mock-codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      })
      break

    case 'account/read':
      sendResult(id, {
        account: state.loggedIn
          ? { type: 'chatgpt', email: state.email, planType: state.planType }
          : null,
        requiresOpenaiAuth: !state.loggedIn,
      })
      break

    case 'account/login/start': {
      const loginId = randomUUID()
      state.pendingLoginId = loginId
      const type = params?.type

      if (type === 'chatgptDeviceCode') {
        sendResult(id, {
          type: 'chatgptDeviceCode',
          loginId,
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        })
      } else if (type === 'chatgpt') {
        sendResult(id, {
          type: 'chatgpt',
          loginId,
          authUrl: 'https://chatgpt.com/example',
        })
      } else {
        sendError(id, -32602, `Unknown login type: ${type}`)
      }
      break
    }

    case 'account/login/cancel':
      state.pendingLoginId = null
      sendResult(id, { status: 'canceled' })
      break

    case 'account/logout':
      state.loggedIn = false
      state.email = null
      state.planType = null
      sendResult(id, {})
      // 模拟 account/updated 通知
      sendNotification('account/updated', { authMode: null, planType: null })
      break

    case 'model/list':
      sendResult(id, {
        data: MODELS,
        nextCursor: null,
      })
      break

    case 'thread/start': {
      const threadId = `thr_${randomUUID().slice(0, 8)}`
      const model = params?.model ?? null
      const developerInstructions = params?.developerInstructions ?? null

      state.threads.set(threadId, { id: threadId, developerInstructions, model })
      recorded.threadStarts.push({ threadId, model, developerInstructions })

      sendResult(id, {
        thread: {
          id: threadId,
          sessionId: `sess_${randomUUID().slice(0, 8)}`,
          forkedFromId: null,
          parentThreadId: null,
          preview: '',
          ephemeral: false,
          section: null,
          sectionEnteredAt: null,
          modelProvider: 'openai',
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
          recencyAt: null,
          status: 'idle',
          path: null,
          cwd: '',
          cliVersion: '0.148.0',
          source: 'app-server',
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: model ?? '',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '',
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: null,
      })

      // 模拟 thread/started 通知
      sendNotification('thread/started', {
        thread: { id: threadId, status: 'idle' },
      })
      break
    }

    case 'thread/resume': {
      const threadId = params?.threadId
      if (!state.threads.has(threadId)) {
        sendError(id, -32001, `Thread not found: ${threadId}`)
        break
      }
      sendResult(id, {
        thread: { id: threadId, status: 'idle' },
        model: state.threads.get(threadId).model ?? '',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '',
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: null,
      })
      break
    }

    case 'thread/delete': {
      const threadId = params?.threadId
      state.threads.delete(threadId)
      sendResult(id, {})
      break
    }

    case 'turn/start': {
      const threadId = params?.threadId
      const model = params?.model ?? null
      const effort = params?.effort ?? null

      const turnId = `turn_${randomUUID().slice(0, 8)}`
      const itemId = `item_${randomUUID().slice(0, 8)}`

      state.turns.set(turnId, { threadId, model, effort })
      recorded.turnStarts.push({ threadId, model, effort })

      sendResult(id, {
        turn: {
          id: turnId,
          items: [],
          itemsView: 'all',
          status: 'in_progress',
          error: null,
          startedAt: Math.floor(Date.now() / 1000),
          completedAt: null,
          durationMs: null,
        },
      })

      // 模拟通知序列
      sendNotification('turn/started', {
        threadId,
        turn: { id: turnId, status: 'in_progress', items: [], itemsView: 'all', error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null },
      })

      sendNotification('item/started', {
        item: { type: 'agentMessage', id: itemId, text: '', phase: null, memoryCitation: null },
        threadId,
        turnId,
        startedAtMs: Date.now(),
      })

      // 模拟流式 delta — 随机选择回复模板
      const template = REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)]
      const fullText = template()
        .replace('MODEL_PLACEHOLDER', model ?? '无')
        .replace('EFFORT_PLACEHOLDER', effort ?? '无')
      const chunks = []
      // 按字符拆分，模拟流式效果
      let i = 0
      while (i < fullText.length) {
        const len = Math.min(Math.floor(Math.random() * 3) + 1, fullText.length - i)
        chunks.push(fullText.slice(i, i + len))
        i += len
      }

      let delay = 50
      let charIndex = 0
      for (const chunk of chunks) {
        setTimeout(() => {
          sendNotification('item/agentMessage/delta', {
            threadId,
            turnId,
            itemId,
            delta: chunk,
          })
        }, delay)
        delay += 30 + Math.floor(Math.random() * 50)
        charIndex++
      }

      // 模拟 item/completed 和 turn/completed
      const completedText = chunks.join('')
      setTimeout(() => {
        sendNotification('item/completed', {
          item: { type: 'agentMessage', id: itemId, text: completedText, phase: null, memoryCitation: null },
          threadId,
          turnId,
          completedAtMs: Date.now(),
        })
      }, delay + 50)

      setTimeout(() => {
        sendNotification('turn/completed', {
          threadId,
          turn: {
            id: turnId,
            items: [{ type: 'agentMessage', id: itemId, text: completedText, phase: null, memoryCitation: null }],
            itemsView: 'all',
            status: 'completed',
            error: null,
            startedAt: Math.floor(Date.now() / 1000),
            completedAt: Math.floor(Date.now() / 1000),
            durationMs: delay + 100,
          },
        })
      }, delay + 100)
      break
    }

    case 'turn/interrupt': {
      const { threadId, turnId } = params
      sendResult(id, {})

      // 模拟 turn/completed with interrupted status
      setTimeout(() => {
        sendNotification('turn/completed', {
          threadId,
          turn: {
            id: turnId,
            items: [],
            itemsView: 'all',
            status: 'interrupted',
            error: null,
            startedAt: null,
            completedAt: Math.floor(Date.now() / 1000),
            durationMs: null,
          },
        })
      }, 50)
      break
    }

    // 测试断言用：返回记录
    case 'mock/get-recorded':
      sendResult(id, recorded)
      break

    default:
      sendError(id, -32601, `Method not found: ${method}`)
      break
  }
}

// ===== 模拟登录完成 =====
function simulateLoginComplete() {
  // 仅在手动登录流程后由调用方触发（测试用）
  // 这里提供：测试可通过发送 account/login/start 后自动触发
}

// ===== stdin 处理 =====
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
})

rl.on('line', (line) => {
  line = line.trim()
  if (!line) return

  let msg
  try {
    msg = JSON.parse(line)
  } catch (e) {
    // JSON parse error 忽略
    return
  }

  // 处理 notification（无 id）
  if (!msg.id) {
    if (msg.method === 'initialized') {
      // 客户端初始化完成，无操作
    }
    return
  }

  handleRequest(msg)
})

// 进程退出处理
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// 启动就绪信号（stderr）
process.stderr.write('[mock-app-server] ready\n')