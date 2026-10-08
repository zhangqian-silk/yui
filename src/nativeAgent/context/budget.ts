import type { ModelRequest, StepScope } from '../contracts.js';
import { ContextBuildError } from './index.js';

export type ContextUnit = 'tokens' | 'bytes' | 'custom';
export type ContextMeasurement = {
  unit: ContextUnit;
  source: string;
  accuracy: 'exact' | 'estimated' | 'unknown';
  value?: number;
  /** Explicit caller-assumed upper undercount, in the same units; not a universal tokenizer guarantee. */
  uncertainty?: number;
};
export interface ContextCounter {
  id: string;
  /** Counts the complete request, including tool declarations and encoding overhead. */
  count(request: ModelRequest): ContextMeasurement;
}
export type ContextCapacity = {
  model: string;
  revision: string;
  unit: ContextUnit;
  contextWindow: number;
  counterId: string;
  maxOutput?: number;
};
export interface ContextCapacitySource {
  id: string;
  /** Re-resolved before every projection, including manual and summary requests. */
  resolve(scope: Readonly<StepScope>, signal: AbortSignal): Promise<ContextCapacity>;
}
export type ContextBudget = {
  capacity: number;
  reserveOutput: number;
  reserveTools?: number;
  safetyMargin?: number;
};
export function validCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}
const units = ['tokens', 'bytes', 'custom'];
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export function measure(counter: ContextCounter, request: ModelRequest, capacity?: ContextCapacity):
  { measurement: ContextMeasurement; upper: number } {
  let measurement: ContextMeasurement;
  try { measurement = structuredClone(counter.count(request)); }
  catch { throw new ContextBuildError('estimation_failed', `Counter failed: ${counter.id}`); }
  if (!measurement || measurement.accuracy === 'unknown')
    throw new ContextBuildError('count_unknown', 'Request count is unknown; no model request admitted');
  if (!units.includes(measurement.unit) || !text(measurement.source)
    || !validCount(measurement.value)
    || !['exact', 'estimated'].includes(measurement.accuracy)
    || !validCount(measurement.uncertainty)
    || (measurement.accuracy === 'exact' && measurement.uncertainty !== 0))
    throw new ContextBuildError('invalid_estimate', 'Count requires units, source, accuracy and explicit uncertainty');
  if (capacity && (capacity.unit !== measurement.unit || capacity.counterId !== counter.id))
    throw new ContextBuildError('capacity_mismatch', 'Model capacity and counter units/identity differ');
  const upper = measurement.value + measurement.uncertainty;
  if (!validCount(upper)) throw new ContextBuildError('invalid_estimate', 'Count plus uncertainty overflows');
  return { measurement, upper };
}
export function budgetBounds(budget: ContextBudget, model?: ContextCapacity) {
  if (!budget || typeof budget !== 'object')
    throw new ContextBuildError('invalid_budget', 'An explicit capacity and reserve budget is required');
  const capacity = model?.contextWindow ?? budget.capacity;
  const reserveTools = budget.reserveTools ?? 0, safetyMargin = budget.safetyMargin ?? 0;
  const reserve = budget.reserveOutput + reserveTools + safetyMargin;
  if (![capacity, budget.capacity, budget.reserveOutput, reserveTools, safetyMargin, reserve].every(validCount)
    || capacity === 0 || reserve > capacity)
    throw new ContextBuildError('invalid_budget', 'Invalid capacity or output/tool/safety reservations');
  if (model && (!text(model.model) || !text(model.revision) || !text(model.counterId)
    || !units.includes(model.unit) || (model.maxOutput !== undefined
      && (!validCount(model.maxOutput) || budget.reserveOutput > model.maxOutput))))
    throw new ContextBuildError('capacity_mismatch', 'Invalid model capability or output reservation exceeds supported output');
  return { capacity, reserveOutput: budget.reserveOutput, reserveTools, safetyMargin, availableInput: capacity - reserve };
}
