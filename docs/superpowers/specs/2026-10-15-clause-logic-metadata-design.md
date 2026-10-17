# 条款逻辑元数据与三值求值设计

## 目标

为伤情和伤残标准中的同时条件、任选条件、数量阈值及附加限定建立可审阅的本地逻辑结构。服务端只在每个必要条件获得来源事实支持时保留 `preliminary`；未标注或无法判定的条件保持 `unknown`。保留原条文、条款 ID、两阶段模型流程和现有对外结果结构。

## 当前问题

- `gemini/data/injury.json` 和 `disability.json` 的条款目前只有 `id`、`grade`、`category`、`text`，没有条件分组。
- `providerResultSchema` 仅接收扁平 `conditions[]` 和 `met: true | false | null`。模型可能把同一 OR 组拆成多个条件，也可能把 AND 条件整体报成一个布尔值。
- `results.js` 只安全识别一部分简单 OR/分号替代项。含附加限定、混合 AND/OR、限定词作用范围不清的条款会保持保守，但尚无可审阅的条款级覆盖状态。
- 当前目录共 847 条款。现按字面 `或/或者` 扫描到 268 条含 OR 的条款（伤情 141、伤残 127）；较宽的旧扫描记录为 276 条，实施前需固定扫描规则并核对差异。

## 方案

### 版本化条款元数据

新增 `gemini/data/clause-logic-v1.json`，按评估类型和条款 ID 保存逻辑树。节点使用以下结构：

```json
{
  "version": 1,
  "clauses": {
    "injury": {
      "5.6.4.b": {
        "annotation": "explicit",
        "logic": {
          "op": "condition",
          "sourceText": "肋骨骨折2处以上",
          "conditionText": "肋骨骨折2处以上",
          "predicate": { "field": "fracture_site_count", "operator": "gte", "value": 2, "unit": "处" }
        }
      }
    }
  }
}
```

每个 `condition` 叶子都必须声明 `factMatch` 或 `predicate`。`factMatch` 使用现有规范字段和值的精确匹配；数量条件使用现有 typed fact 的显式 predicate，例如 `{ "field": "fracture_site_count", "operator": "gte", "value": 2, "unit": "处" }`。仅有 `sourceText` 子串命中不构成事实支持。`sourceText` 必须是官方条款的可定位片段，用于目录加载时验证来源；`conditionText` 是向模型和用户显示的条件文本。若任一必要叶子没有可验证的现有字段和值映射，整条款保持 opaque。

`annotation` 只区分 `explicit` 和 `opaque`。按条文连接关系人工确认、且每个叶条件都有可验证字段映射的逻辑树用 `explicit`；未标注条款在目录加载时获得一个 `opaque` 节点。opaque 条款的值始终为 unknown，即使源文中偶然包含完整条款文字也不能自动升级。这里的人工确认不等同于专家认证。

### 加载与消费

- `catalog.js` 加载静态条款和版本化逻辑元数据，验证类型、条款 ID、操作符、子节点数量和来源片段。未知条款 ID、无效树或不匹配的 sourceText 在启动时失败，避免静默错绑。
- `catalogContext()` 将已校验的逻辑元数据随条款提供给评估阶段。评估提示要求模型按逻辑树列出可核验的条件组；模型提出的状态仍不作为最终依据。
- `results.js` 将模型条件绑定到逻辑树的必要子组及规范事实 ID，再为 condition 叶子计算三值状态。模型漏报任何必要子组、条件文本有歧义、字段/值不匹配、或没有可回查来源事实时，该叶子/子组为 unknown。
- 显式骨折处数事实的引文须保留可回查的数字和单位；序号、肋骨根数与骨折处数继续分开。
- 数量 predicate 仅使用来源可回查、状态可靠的结构化事实。明确数量低于阈值可为 false；未报告数量为 unknown。疑似、排除与冲突仍按事实 certainty 处理，冲突继续触发全局复核。
- `all`：任一子条件 false 则 false；全部 true 才 true；其余 unknown。
- `any`：任一子条件 true 则 true；全部 false 才 false；其余 unknown。
- 只有根节点为 true、无影响结论的冲突、引用和事实来源校验通过时，条款才可支持 preliminary。
- 最终 `references[].conditions[]` 保持现有字段结构；每项映射树的一个必要子组，`condition` 文本保留对应官方逻辑片段，`met` 为该组求值结果，`factIds`/`evidence` 只保留该组的来源事实。子组投影超过 schema 当前 12 项上限时，使用一个根组摘要项，不丢弃内部求值条件。无需变更 API 结果 schema 或 UI 存储结构。

### 元数据覆盖策略

- 先固定全目录扫描器和分类报告：OR 连接、分号列项、逗号 AND、括号限定、嵌套/混合逻辑、之一/枚举及量化词。
- 仅为语法作用范围明确且可以被现有事实字段验证的条款建立 `explicit` 树。
- 有共享限定范围、隐含主语、字段/值映射缺失、语义枚举、单位转换或连接词歧义的条款先保持 `opaque`，不得以字符串命中自动升级。
- 首批元数据须覆盖可由现有事实 schema 可靠核验的回归条款；5.2.2.a 和 5.2.2.c 等共享限定范围用例必须验证为 opaque/unknown，除非其每个叶子都获得有证据的字段映射。安全映射到 injury type 与处数阈值的肋骨 2 处/6 处条款也纳入 explicit，便于明确计数时比较相邻等级。随后用扫描器报告实际 explicit/opaque 数量和未覆盖语法。

## 文件范围

- 新增：`gemini/data/clause-logic-v1.json`，保存可审阅的条款逻辑元数据。
- 修改：`gemini/lib/catalog.js`、`gemini/lib/assessment.js`、`gemini/lib/results.js`，完成加载校验、模型指引、组绑定及递归三值求值。
- 修改：`gemini/lib/facts.js`，让显式处数证据保留数字单位，避免事实字段与引文脱节。
- 测试：扩展既有 `tests/results.test.js`、`tests/stability.test.js`；将 `tests/fixtures.js` 的 UI 示例改为明确的本地 mock payload，避免模拟界面结果调用生产等级门控；不新增测试文件或依赖。

该变更需要新增 1 个生产数据文件并修改 3 个生产模块，超出原 3 个生产文件上限；用户已明确批准扩展逻辑结构与条款元数据。来源/事件/人物的通用 provenance schema 不属于本次批准范围，不新增。

## 验证

- 元数据校验：所有键引用实际条款；每个节点符合递归结构；sourceText 可在对应官方条文中定位；每个 explicit condition 均有有效 factMatch/predicate；缺失元数据生成永远为 unknown 的 opaque 默认树。
- 三值逻辑：覆盖 all/any 真、假、未知真值表以及嵌套 mixed tree。
- 事实绑定：覆盖错误 factId、无引文、无关引文、排除/疑似事实、同一事实多来源及重复处理稳定性。
- 条款回归：覆盖单纯 OR、OR+AND、附加限定、分号备选、数量 threshold 和历史数量不支持当前条款；未知叶子不得形成 grade。
- 全目录审计：输出结构覆盖统计和 opaque 条款数量；不把结构/引文通过等同于法律或医学正确性。
- 执行相关测试、完整 `npm test`、`npm run build`、单 worker 浏览器回归及 `git diff --check`。不调用真实模型 API，不提交、不推送、不部署。

## 已知限制

元数据准确性取决于对官方句法作用范围的人工校阅；本地没有独立法医/医学专家金标准。没有明确元数据的复杂条款继续 fail closed，因此首批实现不会宣称覆盖全部 847 条款或改善临床、法医、法律准确率。

## 已批准补充：事实所属事件

用户于 2026-10-15 批准为可复现的跨事件 AND 合并风险扩展最小事实元数据。事实提取项增加可空的 `eventId`（同一事实事件内一致，无法确认时缺省/为 null）；规范化保留该 ID，精确匹配的解析派生事实只在原文引用和事实字段能安全映射时继承。ID 格式受 schema 校验，但 ID 的语义分组仍是模型声明，提示必须明确：不同事故/事件使用不同 ID，同一事件后续治疗只在原文关联明确时复用 ID，不确定时不得猜分组。

显式 `all` 条款只有在每个必需子组均有来源支持，且这些支持事实存在同一个非空 `eventId` 时才为 true；各组来自不同事件、任一关键组缺 ID 或关联歧义时为 unknown。`any` 可由一个明确支持的分支成立，不要求凑齐其它事件的分支。两个事实仅在双方 eventId 相同或至少一方未知时参与事实冲突关联；两个明确不同事件的差异值分别保留，不作为同一事件冲突。

不使用年份正则自行推断 eventId，也不从描述顺序推断因果关系。当前实现仍无法验证模型分配的 eventId 是否医学真实，ID 缺失时保守 unknown；这提高关联可审查性，不等于专家认证。保持两阶段流程和 API 结果结构兼容，不新增第三方依赖或持久层。

实现边界补充：事件 ID 已知时，条件树按事件分别求值；无事件 ID 的事实只有在其字段可能命中当前条件叶时才形成一个 unscoped 评估范围。无关字段的解析派生事实不阻塞已知事件的真/假结果。只要未归属事实可能支持该树，整体仍不能因为另一个事件为真/假而被强行确定。
