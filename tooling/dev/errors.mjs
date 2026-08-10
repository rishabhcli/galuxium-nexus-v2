export class DevContractError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'DevContractError';
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function printFailure(error) {
  const code = error instanceof DevContractError ? error.code : 'DEV_UNEXPECTED';
  process.stderr.write(`[${code}] ${errorMessage(error)}\n`);
  if (error instanceof DevContractError && error.details !== undefined) {
    const details =
      typeof error.details === 'string' ? error.details : JSON.stringify(error.details, null, 2);
    process.stderr.write(`${details}\n`);
  }
}
