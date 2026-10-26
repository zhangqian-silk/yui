/** Shared, static handoff text. Never interpolate registry URLs, credentials or
 * browser observations into executable instructions. Copying grants no authority. */
export const MODEL_OPERATOR_PROMPTS = {
  zh: {
    metabridge: "请帮我接入 metabridge。先运行 `yui models guide metabridge --json` 阅读当前安装版本的操作指南，再核对已有服务和 Agent 配置。优先复用已有服务，不默认安装或托管。确认我要用于哪个 Agent，以及只影响 Yui 新会话还是修改个人原生配置；已有原生配置可用时不要重复绑定。缺少必要信息再问我，密钥只使用私有文件引用，不要贴到对话中。先说明具体改动与影响，获得确认后预览、备份并执行，最后回读结果。未经单独授权不要重启、升级、调用真实模型或查询账户额度。",
    binding: "请帮我调整 Agent 使用的模型服务。先运行 `yui models guide binding --json`，核对已配置的 Agent、原生方式和现有服务，只问我缺少的选择。说明最终哪个 Agent 使用哪个服务和模型，默认只影响 Yui 新会话；不要更改个人配置或打断已有会话。已有原生配置满足需求时保留它。获得确认后预览并保存，回读结果；不要把保存成功当作模型调用验证，不要在对话中输出密钥。",
    maintenance: "请帮我配置 metabridge。先运行 `yui models guide maintenance --json`，检查已有服务、版本和配置文件，确认我要使用的 Agent、模型和生效范围。优先复用已有实例，不默认安装或托管；已有原生配置满足需求时保留它。只问我缺少的必要信息，密钥使用私有文件引用，不要贴到对话中。先说明具体改动、影响和恢复方式，获得确认后预览、备份并执行，最后回读结果。未经单独授权不要升级、重启、删除配置、修改个人默认模型、调用真实模型或查询账户额度。"
  },
  en: {
    metabridge: "Help me connect metabridge. First run `yui models guide metabridge --json` and read the manuals shipped with this installation. Inspect existing services and Agent settings; reuse an existing service without installing or adopting it by default. Confirm the Agent and whether the change is for new Yui Sessions or personal native configuration. Keep working native settings instead of adding a redundant binding. Ask only for missing information; use private credential-file references, never secrets in chat. Explain changes and impact, obtain confirmation, preview, back up, apply and read back. Do not restart, upgrade, run real model requests or query account quota without separate authorization.",
    binding: "Help me change the model service used by an Agent. Run `yui models guide binding --json`, inspect configured Agents, native settings and existing services, and ask only for missing choices. Explain which Agent will use which service and model. Default to new Yui Sessions only; do not change personal configuration or interrupt existing Sessions. Preserve native settings when they already meet the goal. After confirmation, preview, save and read back. Saving is not an inference test. Never expose secrets in chat.",
    maintenance: "Help me configure metabridge. Run `yui models guide maintenance --json`, inspect the existing service, version and configuration files, and confirm the Agent, model and effect scope I want. Reuse an existing instance without installing or adopting it by default; preserve native settings when they already meet the goal. Ask only for missing information and use private credential-file references, never secrets in chat. Explain changes, impact and recovery, obtain confirmation, preview, back up, apply and read back. Do not upgrade, restart, delete configuration, change personal defaults, run real model requests or query account quota without separate authorization."
  }
} as const;

export type ModelGuideTopic = keyof typeof MODEL_OPERATOR_PROMPTS.en;
export function modelOperatorGuide(topic: string = "metabridge") {
  if (!Object.hasOwn(MODEL_OPERATOR_PROMPTS.en, topic)) throw new Error("Unknown model guide topic: use metabridge, binding or maintenance.");
  return {
    topic: topic as ModelGuideTopic,
    prompt: MODEL_OPERATOR_PROMPTS.zh[topic as ModelGuideTopic],
    manuals: ["model-components.md", "model-management-api.md", "model-metabridge.md", "model-connection-tools.md", "model-maintenance.md"],
    instructions: [
      "Read the manuals below from this installed package, then inspect the actual component version. Documentation is method, not authorization.",
      "Use your current authenticated Operator identity/Home. Model mutations retain the existing Operator-only capability boundary; Task roles cannot bypass it. Never clear identity or use the browser token as a workaround.",
      "Use an existing authorized Task context for capability calls (--task); do not invent a Task ID or create a Task merely to bypass a missing authorization. Guide itself is offline and needs no Task.",
      "Begin with yui models read --task <actual-task-id> --json. It reads current references and cached facts, never probes upstream. Inspect native settings only within the user's authorized scope.",
      "Clarify only missing goals: exact configured Agent, existing service, model, and new-Yui-session versus personal-native scope. Registration, binding, native file editing and service maintenance are distinct effects.",
      "For existing mixed metabridge official-subscription forwarding, retain native configuration/binding. Explicit Yui API-key endpoint bindings do not support that authentication mode. Never copy native login credentials.",
      "For a Yui-only API-key connection, reuse or register a compatible endpoint using models save, then models preview for the exact binding, then models save. Read the current registryRevision before each write; use stable request IDs and read back each result. No module registration is required just to bind an endpoint.",
      "For personal native configuration, use models connection-preview and connection-apply with the exact returned planDigest, or node <installed-package>/dist/models/configureConnection.js as documented in model-connection-tools.md. Provider addition and default switching are separate. Exclude other writers, retain backups and enforce revision checks.",
      "Keep secrets out of prompts, arguments, output and logs. Use private credential files; do not reuse management or native-login credentials as inference keys.",
      "Maintenance is optional. Use models read with kind=maintenance and exact resourceId before models maintain. Confirm trusted source/pinned commit and exact service ownership. Starting, restarting, updating and handing off require explicit scope; do not adopt a service by its port/name.",
      "On unknown outcome, inspect original request/Job and current facts before any retry; keep the same request IDs and never replay to repair a missing receipt. Accepted Job is not saved/applied: follow the returned Job Run and business result.",
      "Return concise results: target Agent/service/model, effect scope, saved/applied/new-session-only/unknown, backup or recovery location, and unverified checks. Refresh the Web view after readback. Do not consume real model/quota or restart shared daemons as an implicit test."
    ],
    cli: {
      read: "yui models read --task <actual-task-id> [--input '{\"kind\":\"catalog\",\"resourceId\":\"endpoint-id\"}'] --json",
      preview: "yui models preview --task <actual-task-id> --input '{\"revision\":\"READ_REGISTRY_REVISION\",\"binding\":{...}}' --json",
      save: "yui models save --task <actual-task-id> --input '{\"revision\":\"READ_REGISTRY_REVISION\",\"requestId\":\"STABLE_WRITE_ID\",\"kind\":\"binding\",\"resource\":{...}}' --json",
      other: "save-provider | refresh | maintain | connection-preview | connection-apply use --task and --input with the corresponding documented Web request body. These shortcuts wrap the existing capability; they do not infer missing fields or execute multiple effects."
    }
  };
}
