## 本 Agent 中约定的术语如下表

| 术语 | 说明 | 进一步澄清 |
|---|---|---|
| BASE_URL | https://docflow.textin.com/agent-center | DocFlow 平台地址 |
| 用户 | 操作 Super Agent 的使用者 | 包括通过任何 channel 连接到 Super Agent 的使用者，包括 Web UI、以及 feishu 等 IM 工具 |
| case_no | 文档上传到 DocFlow 平台后，会获得的唯一识别码 | 该值会在调用 DocFlow 平台的上传文档 api 后获得，与 api 返回结果中的变量名一致 |


## 首轮审核流程

当用户没有提供 case_no 时，判定需要对用户上传的文件进行首轮审核。

### Step 1: 前置条件检查

**附件检查：**确认用户在对话过程中是否上传了附件，如果没有任何附件，需要提醒用户上传

**BASE_URL 检查：**确认 BASE_URL 是否可用

执行以下命令判断 BASE_URL 是否可用：

```
curl -sI -o /dev/null -w "%{http_code}" -L {BASE_URL}
```

如果 BASE_URL 可用，继续执行后续步骤；如果不可用，提示用户后端服务不可用。

### Step 2: 上传文件创建案件

将用户上传的附件，上传到 DocFlow 平台。使用以下命令上传：

```
curl -X POST https://docflow.textin.com/agent-center/api/contract-audit/upload \
  -F "files=@{UPLOADED_FILE_PATH}/{UPLOADED_FILE_NAME}" \
  -F "doc_type=auto"
```

返回结构：

```json
{
  "case_id": "42",
  "case_no": "CASE-0419-XXXXX",
  "file_ids": ["101"],
  "file_count": 1,
  "mode": "new"
}  
```

**操作要点**：

- 记录返回的 `case_no`，和 case_id，后续所有步骤需要用到
- 确保文件上传成功后再进入下一步

### Step 3: 等待工作流完成

使用浏览器打开案件详情页，监控工作流执行进度。

**启动浏览器**：调用 `start_browser_session` 时必须传入 `{"region": "ap-northeast-1"}`。

只需要在【运行流程】Tab 下观察工作流执行进度，**不要**尝试使用其它 Tab 页观察流程

```
详情页地址: ${BASE_URL}/contract-audit/cases/${case_no}
```

**工作流阶段**：

1. **文档解析** (`doc_parse`) — 自动 OCR 识别与结构化提取
2. **文档分类** (`doc_classify`) — 自动分类
3. **字段提取** (`field_extract`) — 自动提取合同字段
4. **文档匹配** (`doc_match`) — 自动匹配
5. **规则校验** (`rule_validate`) — 自动校验
6. **风险检测** (`risk_detect`) — 自动检测风险
7. **审核决策** (`audit_decide`) — **需要人工确认**
8. **系统交互** (`system_interact`) — 自动执行

**等待机制**：

所有阶段均采用 **5 秒间隔轮询**：

1. 页面加载完成后，点击「运行流程」按钮启动工作流

2. 每 5 秒检查阶段状态变更

3. 在相同 channel 中通知用户 case 已经创建，case_no 是什么

4. 当检测到 `audit_decide` 阶段弹出 interrupt 卡片时，停止轮询

5. 查看「审核决策」中给出的反馈，并在相同 channel 中通知用户，等待用户决策

6. 根据用户给出的反馈，执行审核决策操作：
   - 如果当前浏览器 session 已过期或不可用，需要重新调用 `start_browser_session`（传入 `{"region": "ap-northeast-1"}`）并导航到案件详情页 `${BASE_URL}/contract-audit/cases/${case_no}`
   - 在页面的「审核决策」区域中，找到并点击对应的按钮（【通过】、【驳回】、【挂起】）
   - 在弹出的确认对话框中，填写用户反馈的内容作为审核意见
   - 点击确认按钮提交决策

7. 继续以 5 秒间隔轮询，等待 `system_interact` 阶段完成

8. 处理完毕后，在相同 channel 中通知用户处理的最终结果，注意使用以下格式：

   ```
   合同审核结果通知：
   CASE_NO：{case_no}  
   CASE_ID：{case_id}  
   审核结论：{审核决策结论}  
   审核要点：
   - ...（总结审核理由摘要）
   ```
   
   

## 复审流程

当用户上传文档、并提供了 case_no 时，代表用户发起了对已有案件的复审流程。

### Step 1: 前置条件检查

**附件检查：**确认用户在对话过程中是否上传了附件，如果没有任何附件，需要提醒用户上传

**BASE_URL 检查：**确认 BASE_URL 是否可用

执行以下命令判断 BASE_URL 是否可用：

```
curl -sI -o /dev/null -w "%{http_code}" -L {BASE_URL}
```

如果 BASE_URL 可用，继续执行后续步骤；如果不可用，提示用户后端服务不可用。

通过浏览器工具，打开案件详情页地址：

**启动浏览器**：调用 `start_browser_session` 时必须传入 `{"region": "ap-northeast-1"}`。

```
${BASE_URL}/contract-audit/cases/${case_no}
```

### Step 2: Agent 助手追加文件并重跑任务

**操作步骤**：

1. 在浏览器页面左侧，找到「 Agent 助手」聊天区域

2. 将用户在本次聊天过程中上传的文件上传到 DocFlow 平台。使用以下命令上传：

   ```
   curl -X POST https://docflow.textin.com/agent-center/api/contract-audit/upload \
     -F "files=@{UPLOADED_FILE_PATH}/{UPLOADED_FILE_NAME}" \
     -F "doc_type=auto" \
     -F "case_id={case_id}" \
     -F "mode=append"
   ```

3. 在「 Agent 助手」的聊天窗口中发送消息：`追加文件,重跑任务`

4. Agent 助手会自动追加文件并触发 Pipeline 重跑

**操作要点**：

- 确认 Agent 助手已开始处理后进入下一步

### Step 3: 等待合同比对完成，预览比对结果

以 5 秒间隔轮询，继续在浏览器中等待合同对比阶段完成，并预览比对结果。

**等待 `doc_compare` 完成**：

等待页面中 `doc_compare` 阶段卡片状态变为完成（ <上一次上传文档> 与 <本次上传文档> 差异对比）。

**预览比对**：

1. 在 `doc_compare` 阶段卡片中，找到并点击「预览比对」按钮
2. 等待合同预览比对弹窗打开，左右两侧文件预览均加载完毕
3. 把右侧差异列表中的 **所有** 内容通过原 channel 返回给用户
4. 等待 **3 秒**后关闭弹窗

### Step 4: 等待工作流完成，人工审核通过

继续使用浏览器工具，在案件详情页等待剩余阶段完成。

**等待机制**：

只需要在【运行流程】Tab 下观察工作流执行进度，**不要**尝试使用其它 Tab 页观察流程

5 秒间隔轮询：

1. 继续等待后续 `field_extract`、`doc_match`、`rule_validate`、`risk_detect` 阶段完成
2. 当 `audit_decide` 阶段 interrupt 卡片弹出时，停止轮询
3. 查看「审核决策」中给出的反馈，并在相同 channel 中通知用户，等待用户决策
4. 根据用户给出的反馈，执行审核决策操作：
   - 如果当前浏览器 session 已过期或不可用，需要重新调用 `start_browser_session`（传入 `{"region": "ap-northeast-1"}`）并导航到案件详情页 `${BASE_URL}/contract-audit/cases/${case_no}`
   - 在页面的「审核决策」区域中，找到并点击对应的按钮（【通过】、【驳回】、【挂起】）
   - 在弹出的确认对话框中，填写用户反馈的内容作为审核意见
   - 点击确认按钮提交决策
5. 继续以 5 秒间隔轮询，等待 `system_interact` 阶段完成
6. 处理完毕后，在相同 channel 中通知用户处理的最终结果

### Step 5: 发送消息通知审核结果

在相同 channel 中发送消息，内容为审核通过结论及合同比对要点，格式示例：

```
合同审核通过通知：
审核结论：{审核决策结论}
比对要点：
- 付款条款已修正为净30天
- 补充了违约责任条款
- ...（列出实际比对差异摘要）
审核要点：
- ...（总结审核理由摘要）
```

**注意**：消息内容需保持换行格式，确保每行独立显示，不要合并成一行发送。反馈的消息内容要注意简洁。

### Step 6: 推送到 OA 系统

如果复审结果是【通过】，需要进一步操作 OA 系统。

如果当前浏览器 session 已过期，需要重新调用 `start_browser_session`（传入 `{"region": "ap-northeast-1"}`）。

1. 在浏览器中打开案件详情页 `${BASE_URL}/contract-audit/cases/${case_no}`，在中间最下方的「系统交互」卡片中，点击「OA审批系统」的【查看详情】链接
2. 页面会在浏览器新的 Tab 页中打开「OA 合同审批系统」，在 OA 系统页面中找到【审批流程】 Tab 栏，点击进入审批流程
3. 页面最下方找到审批操作区域
4. 根据审核结果（通过）填写审批意见
5. 点击「同意」按钮完成 OA 审批

