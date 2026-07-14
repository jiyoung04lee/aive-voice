import "server-only";

const RTZR_AUTHENTICATE_URL = "https://openapi.vito.ai/v1/authenticate";
const RTZR_TRANSCRIBE_URL = "https://openapi.vito.ai/v1/transcribe";

interface RtzrFileTranscriptionConfig {
  model_name: "sommers";
  language: "ko";
  use_diarization: boolean;
  diarization: {
    spk_count: number;
  };
  use_itn: boolean;
  use_disfluency_filter: boolean;
  use_paragraph_splitter: boolean;
  paragraph_splitter: {
    max: number;
  };
  domain: "GENERAL";
}

const config: RtzrFileTranscriptionConfig = {
  model_name: "sommers",
  language: "ko",
  use_diarization: true,
  diarization: {
    spk_count: 2,
  },
  use_itn: true,
  use_disfluency_filter: true,
  use_paragraph_splitter: true,
  paragraph_splitter: {
    max: 80,
  },
  domain: "GENERAL",
};

export interface RtzrAuthToken {
  access_token: string;
  expire_at: number;
}

interface RtzrErrorResponse {
  code: string;
  msg: string;
}

export interface RtzrTranscriptionJob {
  id: string;
}

export class RtzrConfigurationError extends Error {
  constructor(public readonly missingVariables: readonly string[]) {
    super(`필수 환경변수가 없습니다: ${missingVariables.join(", ")}`);
    this.name = "RtzrConfigurationError";
  }
}

export class RtzrAuthenticationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`RTZR 인증에 실패했습니다. (${code})`);
    this.name = "RtzrAuthenticationError";
  }
}

export class RtzrHttpError extends Error {
  constructor(public readonly status: number) {
    super(`RTZR 인증 요청이 실패했습니다. (HTTP ${status})`);
    this.name = "RtzrHttpError";
  }
}

export class RtzrAuthResponseError extends Error {
  constructor() {
    super("RTZR 인증 응답 형식이 올바르지 않습니다.");
    this.name = "RtzrAuthResponseError";
  }
}

export class RtzrTranscriptionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`RTZR 파일 전사 요청에 실패했습니다. (${code})`);
    this.name = "RtzrTranscriptionError";
  }
}

export class RtzrTranscriptionHttpError extends Error {
  constructor(public readonly status: number) {
    super(`RTZR 파일 전사 요청이 실패했습니다. (HTTP ${status})`);
    this.name = "RtzrTranscriptionHttpError";
  }
}

export class RtzrTranscriptionResponseError extends Error {
  constructor() {
    super("RTZR 파일 전사 응답 형식이 올바르지 않습니다.");
    this.name = "RtzrTranscriptionResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRtzrErrorResponse(value: unknown): value is RtzrErrorResponse {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.msg === "string"
  );
}

function isRtzrTranscriptionJob(
  value: unknown,
): value is RtzrTranscriptionJob {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

function isRtzrAuthToken(value: unknown): value is RtzrAuthToken {
  return (
    isRecord(value) &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0 &&
    typeof value.expire_at === "number" &&
    Number.isFinite(value.expire_at)
  );
}

function readRtzrCredentials(): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = process.env.RTZR_CLIENT_ID;
  const clientSecret = process.env.RTZR_CLIENT_SECRET;
  const missingVariables: string[] = [];

  if (!clientId?.trim()) {
    missingVariables.push("RTZR_CLIENT_ID");
  }

  if (!clientSecret?.trim()) {
    missingVariables.push("RTZR_CLIENT_SECRET");
  }

  if (missingVariables.length > 0) {
    throw new RtzrConfigurationError(missingVariables);
  }

  return {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
  };
}

export async function authenticateRtzr(): Promise<RtzrAuthToken> {
  const { clientId, clientSecret } = readRtzrCredentials();
  const requestBody = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(RTZR_AUTHENTICATE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: requestBody,
    cache: "no-store",
  });

  let responseBody: unknown;

  try {
    responseBody = await response.json();
  } catch {
    if (!response.ok) {
      throw new RtzrHttpError(response.status);
    }

    throw new RtzrAuthResponseError();
  }

  if (!response.ok) {
    if (isRtzrErrorResponse(responseBody)) {
      throw new RtzrAuthenticationError(response.status, responseBody.code);
    }

    throw new RtzrHttpError(response.status);
  }

  if (!isRtzrAuthToken(responseBody)) {
    throw new RtzrAuthResponseError();
  }

  return responseBody;
}

export async function createRtzrTranscription(
  file: File,
): Promise<RtzrTranscriptionJob> {
  const { access_token: accessToken } = await authenticateRtzr();
  const requestBody = new FormData();

  requestBody.append("file", file);
  requestBody.append(
    "config",
    JSON.stringify(config),
  );

  const response = await fetch(RTZR_TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: requestBody,
    cache: "no-store",
  });

  let responseBody: unknown;

  try {
    responseBody = await response.json();
  } catch {
    if (!response.ok) {
      throw new RtzrTranscriptionHttpError(response.status);
    }

    throw new RtzrTranscriptionResponseError();
  }

  if (!response.ok) {
    if (isRtzrErrorResponse(responseBody)) {
      throw new RtzrTranscriptionError(response.status, responseBody.code);
    }

    throw new RtzrTranscriptionHttpError(response.status);
  }

  if (!isRtzrTranscriptionJob(responseBody)) {
    throw new RtzrTranscriptionResponseError();
  }

  return responseBody;
}
