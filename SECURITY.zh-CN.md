<p align="right"><a href="./SECURITY.md">English</a> | <strong>简体中文</strong></p>

# 安全策略

## 信任模型

Yui 面向**单个受信任的本地用户**在其自己的机器上使用。它不是 OS 沙箱，也不是远程
多用户服务：

- 你配置的 Agent 以你的本地权限运行。
- Web 视图（`yui web`）仅本地回环、只读；浏览器访问不会变成 Operator 权限。
- 发布、授予新访问权限以及其他外部效果仍需要相应授权。

基于这一模型，“一个 Agent 可以运行你已授权的本地动作”是预期行为，而不是漏洞。

## 受支持的版本

Yui 尚未发布 1.0。安全修复面向最新的已发布版本；如果可以，请在报告前先升级。

## 报告漏洞

请**私下**报告任何涉及安全的问题，不要提交公开 issue：

- 推荐：GitHub 私有漏洞报告——打开仓库的 **Security** 标签页并选择
  **Report a vulnerability**
  (<https://github.com/zhangqian-silk/yui/security/advisories/new>)。
- 请包含描述、受影响的版本或 commit、复现步骤，以及你观察到的影响。

我们会确认你的报告、进行调查，并与你协调修复与披露的时间安排。感谢你帮助保护
Yui 用户的安全。
