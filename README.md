# JackCode 🤖

> 一个独立的 AI 编程助手框架，原生兼容 JackClaw

JackCode 是一个模块化的 AI 驱动代码开发框架，它将复杂的编程任务分解为 20 个专业化的协作模块，实现从代码理解到自动修复的完整工作流。

---

## 🎯 核心特性

### 智能模型路由
- **Qwen 3.6** - 主要执行器，处理日常编码任务
- **DeepSeek** - 升级推理器，解决复杂问题
- **GPT-5.4** - 验证器/修复器，代码质量把关

### 完整开发工作流
```
需求理解 → 代码扫描 → 影响分析 → 补丁生成 → 构建测试 → 自动修复
```

### 企业级功能
- 💰 成本控制和预算管理
- 🔍 代码影响分析和风险评估
- 🔄 自动重试和错误恢复
- 📊 实时遥测和追踪
- 🤝 多节点协作支持

---

## 🏗️ 架构概览

JackCode 由 20 个专业化线程组成：

| 层 | 线程 | 模块 | 功能 |
|---|------|------|------|
| 核心 | 01 | Runtime State Machine | 任务生命周期管理 |
| 核心 | 02 | Session Context Manager | 会话管理、上下文累积 |
| 核心 | 03 | Patch Engine | 统一 diff、自动回滚 |
| 核心 | 04 | Build/Test Loop | 构建集成、测试执行 |
| 理解 | 05 | Repo Scanner | 仓库扫描、依赖分析 |
| 理解 | 06 | Symbol Import Index | AST 符号提取 |
| 理解 | 07 | Impact Analyzer | 变更影响分析 |
| 理解 | 08 | Context Compressor | 上下文压缩 |
| 路由 | 09 | Qwen Router | Qwen 模型路由 |
| 路由 | 10 | DeepSeek Router | 升级推理 |
| 路由 | 11 | GPT-5.4 Verifier | 代码验证、自动修复 |
| 路由 | 12 | Policy & Cost Control | 成本控制 |
| 适配器 | 13 | Node Adapter | WebSocket 连接 |
| 适配器 | 14 | Memory Adapter | 语义查询、同步 |
| 适配器 | 15 | Collaboration Adapter | 任务分发、协作 |
| 体验 | 16 | CLI Chat UX | 交互式 REPL |
| 体验 | 17 | Developer Workflow UX | 工作流可视化 |
| 体验 | 18 | Trace Observability | 分布式追踪 |
| 体验 | 19 | Recovery & Retry Safety | 自动重试、回滚 |
| 体验 | 20 | Integration QA | 集成测试 |

---

## 🚀 快速开始

```bash
# 使用 JackCode CLI
jackcode chat                    # 启动交互式聊天
jackcode run "优化这个函数"       # 执行代码修改
jackcode --resume               # 恢复上次会话
```

---

## 📊 性能指标

| 指标 | 数值 |
|------|------|
| Context 压缩率 | 90.7% (50K → 4.7K tokens) |
| Repo 扫描 (251文件) | 冷: 932ms, 热: 16ms |
| 模块数量 | 20/20 完成 |

---

## 🛠️ 开发状态

- ✅ 所有 20 个线程已完成实现
- ✅ 每个模块都有单元测试
- ✅ 核心 bug 已修复
- 🔄 等待完整集成测试

---

## 📄 许可证

MIT License - 详见 [LICENSE](./LICENSE)

---

由 JackCode Team 用 ❤️ 和 🤖 构建
