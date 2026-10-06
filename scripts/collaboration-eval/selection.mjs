// Variants share their base's split, not independent base cases.
export function parseOptions(args) {
  const options = {}, allowed = new Set(["version", "case", "out", "mode", "allow-holdout"]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    if (!args[i]?.startsWith("--") || !allowed.has(key) || !args[i + 1]
      || args[i + 1].startsWith("--") || Object.hasOwn(options, key))
      throw new Error("Expected --version <checkout> --case <IDs|dev|all> --out <new-dir> [--mode F|P|all] [--allow-holdout true]");
    options[key] = args[i + 1];
  }
  options.mode ??= "F";
  if (!options.version || !options.case || !options.out || !["F", "P", "all"].includes(options.mode)
    || options["allow-holdout"] !== undefined && options["allow-holdout"] !== "true")
    throw new Error("Invalid or incomplete evaluation selection");
  return options;
}

export function selectConditions(options, definitions, variants) {
  const requested = options.case.split(",");
  if (new Set(requested).size !== requested.length) throw new Error("Duplicate requested condition");
  const all = ["all", "dev"].includes(options.case);
  const chosen = all ? definitions.filter(d => options.case === "all" || d.split === "dev")
    : requested.map(id => {
      const variant = variants.find(v => v.id === id);
      const base = definitions.find(d => d.id === (variant?.base ?? id));
      if (!base) throw new Error(`Unknown condition ${id}`);
      return { ...base, selectedVariant: variant?.id };
    });
  if (chosen.some(d => d.split === "holdout") && options["allow-holdout"] !== "true")
    throw new Error("Holdout execution requires explicit --allow-holdout true after development freeze");
  return chosen.flatMap(d => {
    const conditions = [];
    const add = (mode, variant) => conditions.push({
      id: d.id, family: d.family, category: d.category, split: d.split,
      mode, variant, status: "not-run"
    });
    if (options.mode !== "P") {
      add("F", d.selectedVariant ?? "base");
      if (all) for (const v of variants.filter(v => v.base === d.id)) add("F", v.id);
    }
    if (options.mode !== "F" && d.modes.includes("P") && !d.selectedVariant) add("P", "base");
    if (!conditions.length && !all) throw new Error(`Unsupported mode for ${d.id}`);
    return conditions;
  });
}
