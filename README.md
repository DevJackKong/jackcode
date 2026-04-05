# JackCode 🤖

> 一个独立的 AI 编程助手框架，采用简化的双模型架构。

## 模型架构

- **Qwen 3.6** — 开发模型
  - 负责所有开发任务：代码生成、修改、重构、测试、文档、补丁、复杂推理
- **GPT-5.4** — 审计模型
  - 负责质量验证：代码评审、安全扫描、破坏性变更检查、修复建议

DeepSeek 已从架构中完全移除，不再存在升级链路或专门路由。

## 工作流

```text
需求理解 → 规划 → Qwen 3.6 实施 → 构建/测试 → GPT-5.4 审计
```

## 配置

```json
{
  "developer": "qwen-3.6",
  "auditor": "gpt-5.4"
}
```

## 快速开始

```bash
npm install
npm run build
node dist/cli/index.js chat
node dist/cli/index.js --model qwen-3.6 "refactor auth module"
```

## 当前说明

- 开发默认走 **Qwen 3.6**
- 最终验证走 **GPT-5.4**
- 架构更简单，维护成本更低，模型切换更少
