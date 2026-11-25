# 在接单授权之外增加动作级 Approval

原型只在接单时把关：Gate 加上接单模式（off/observe/auto）。执行器一旦开工就拥有全部权限。我们要求做到 L3：低风险动作自动执行，高风险动作需要人批准。因此在 Mandate 之外，再由 Policy 按动作类别声明哪些动作需要审批。需要审批的动作包括：
- 对外写操作：发评论、推送、开或合并 MR、修改 Jira 状态、重跑流水线
- 删除数据
- 修改凭据或权限

执行器在执行这些动作之前，先在工单上生成一条 Approval（Attention 的一种），由人批准后才继续。主 Session 只能提议放宽某类动作，不能自行修改 Policy。后续工单继承前一工单的 Mandate，范围不得扩大；需要更大范围时，同样生成 Approval。

## Consequences

- 拦截要落在执行器的工具调用层，需要接入 harness 的 permission、guard、interaction 机制，不能只靠提示词约束。
- 工单完成必须经过人的验收（也是一种 Attention），不由主 Session 审阅后自动结束。
