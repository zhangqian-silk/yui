import { ROOT_COMMAND, findCommandNode, type CommandNode, type DiscoveryAudience } from "./commandCatalog.js";

/** Offline presentation hints only. Execution still authenticates the original
 * caller, including stale/incomplete identities, at its existing boundary. */
export function discoveryAudience(env: NodeJS.ProcessEnv): DiscoveryAudience {
  const marked = ["YUI_SESSION_SCOPE", "YUI_ROLE", "YUI_AGENT_ID", "YUI_NATIVE_SESSION_ID",
    "YUI_TASK_ID", "YUI_SESSION_MANIFEST"].some(key => env[key] !== undefined);
  if (!marked) return "public";
  if (!env.YUI_ROLE || !env.YUI_NATIVE_SESSION_ID) return "unbound";
  if (env.YUI_SESSION_SCOPE === "global") return env.YUI_ROLE === "operator" ? "operator" : "global";
  if (env.YUI_SESSION_SCOPE === "task" && env.YUI_TASK_ID) return env.YUI_ROLE === "leader" ? "leader" : "assignment";
  return "unbound";
}

export function discoveryCommandTree(env: NodeJS.ProcessEnv): CommandNode {
  const audience = discoveryAudience(env);
  const project = (node: CommandNode): CommandNode | undefined => {
    const children = node.children.map(project).filter((child): child is CommandNode => child !== undefined);
    const eligible = node.discovery?.surface !== "runtime" && node.discovery?.audiences.includes(audience);
    if (!children.length && (!eligible || node.kind === "group") && node !== ROOT_COMMAND) return undefined;
    const executable = eligible && node.kind !== "group";
    const kind = children.length ? executable ? "hybrid" : "group" : node.kind;
    const template = `${node.path.join(" ")}${kind === "group" ? " <command>" : ""}`;
    const omittedOptions = Object.entries(node.discovery?.optionAudiences ?? {})
      .filter(([, audiences]) => !audiences.includes(audience)).map(([option]) => option);
    const text = (value: string) => omittedOptions.reduce((line, option) =>
      line.replace(new RegExp(`\\s*\\[${option}(?:\\s+[^\\]]*)?\\]`, "g"), ""), value);
    const options = node.options.filter(option => !omittedOptions.includes(option));
    // Group prose often contains concrete commands for several audiences.
    // Generate its usage from the same retained children, not unfiltered text.
    return {
      ...node, children, hidden: false, kind,
      usage: kind === "group" ? [template] : node.usage.map(text),
      examples: kind === "group" ? children.slice(0, 3).map(child => child.usage[0]) : node.examples.map(text),
      options, optionValues: Object.fromEntries(Object.entries(node.optionValues).filter(([option]) => options.includes(option))),
      sections: node.sections.map(section => ({ ...section,
        entries: section.entries.filter(entry => children.some(child => child.name === entry) || (executable && node.values.some(value => value.name === entry)))
      })).filter(section => section.entries.length > 0),
      ...(executable ? {} : { options: [], values: [], optionValues: {}, argumentValues: {} })
    };
  };
  const tree = project(ROOT_COMMAND)!;
  if (audience === "public") {
    const sections = [
      { id: "start", title: "Start work", entries: ["operator", "project"] },
      { id: "progress", title: "Inspect progress", entries: ["task", "jobs", "execution", "telemetry"] },
      { id: "participate", title: "Participate and control", entries: ["role", "session"] },
      { id: "maintain", title: "Configure and maintain", entries: ["help", "version", "setup", "start", "doctor", "config", "web", "controller", "resources", "update", "upgrade", "release"] }
    ];
    return { ...tree, sections: sections.map(section => ({ ...section,
      entries: section.entries.filter(entry => tree.children.some(child => child.name === entry))
    })) };
  }
  // Help accepts catalog paths, and config describe accepts only retained domains.
  const config = findCommandNode(["config"], tree);
  if (config) {
    const domains = config.children.filter(child => !["show", "describe"].includes(child.name)).map(child => child.name);
    return {
      ...tree, children: tree.children.map(child => child !== config ? child : {
        ...config, children: config.children.map(node => node.name !== "describe" ? node : {
          ...node, argumentValues: { 0: domains }, usage: ["yui config describe [domain]"],
          examples: ["yui config describe"]
        })
      })
    };
  }
  return tree;
}
