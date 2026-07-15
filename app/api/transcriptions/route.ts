import {
  createRtzrTranscription,
  RtzrAuthenticationError,
  RtzrAuthResponseError,
  RtzrConfigurationError,
  RtzrHttpError,
  RtzrTranscriptionError,
  RtzrTranscriptionHttpError,
  RtzrTranscriptionResponseError,
} from "@/lib/rtzr";

const ALLOWED_AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "wav"]);
const MAX_KEYWORD_COUNT = 500;
const MAX_KEYWORD_LENGTH = 20;
const COMPLETE_HANGUL_SYLLABLE_PATTERN = /^[\uAC00-\uD7A3]+$/u;

type KeywordParseResult =
  | { ok: true; keywords: string[] }
  | { ok: false; error: string };

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function hasAllowedExtension(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase();

  return extension !== undefined && ALLOWED_AUDIO_EXTENSIONS.has(extension);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function parseKeywords(value: FormDataEntryValue | null): KeywordParseResult {
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    return { ok: true, keywords: [] };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "키워드 형식이 올바르지 않습니다." };
  }

  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(value);
  } catch {
    return { ok: false, error: "키워드 형식이 올바르지 않습니다." };
  }

  if (!isStringArray(parsedValue)) {
    return { ok: false, error: "키워드 형식이 올바르지 않습니다." };
  }

  const keywords = Array.from(
    new Set(parsedValue.map((item) => item.trim()).filter(Boolean)),
  );

  if (keywords.length > MAX_KEYWORD_COUNT) {
    return {
      ok: false,
      error: "키워드는 최대 500개까지 입력할 수 있습니다.",
    };
  }

  if (
    keywords.some(
      (keyword) => Array.from(keyword).length > MAX_KEYWORD_LENGTH,
    )
  ) {
    return {
      ok: false,
      error: "키워드는 각각 20자 이하로 입력해주세요.",
    };
  }

  if (
    keywords.some(
      (keyword) => !COMPLETE_HANGUL_SYLLABLE_PATTERN.test(keyword),
    )
  ) {
    return { ok: false, error: "키워드는 한글로만 입력해주세요." };
  }

  return { ok: true, keywords };
}

function handleTranscriptionError(error: unknown): Response {
  if (error instanceof RtzrConfigurationError) {
    return errorResponse(
      "음성 전사 서비스 설정이 완료되지 않았습니다.",
      500,
    );
  }

  if (
    error instanceof RtzrAuthenticationError ||
    error instanceof RtzrHttpError ||
    error instanceof RtzrAuthResponseError
  ) {
    return errorResponse(
      "음성 전사 서비스 인증 중 오류가 발생했습니다.",
      502,
    );
  }

  if (error instanceof RtzrTranscriptionError) {
    if (error.status === 400) {
      return errorResponse("파일 전사 요청을 처리할 수 없습니다.", 400);
    }

    if (error.status === 413) {
      return errorResponse(
        "파일 크기 또는 재생 시간이 허용 범위를 초과했습니다.",
        413,
      );
    }

    if (error.status === 429) {
      return errorResponse(
        "현재 전사 요청을 처리할 수 없습니다. 잠시 후 다시 시도해주세요.",
        429,
      );
    }

    return errorResponse("음성 전사 서비스에서 오류가 발생했습니다.", 502);
  }

  if (
    error instanceof RtzrTranscriptionHttpError ||
    error instanceof RtzrTranscriptionResponseError
  ) {
    return errorResponse("음성 전사 서비스에서 오류가 발생했습니다.", 502);
  }

  return errorResponse("요청을 처리하는 중 오류가 발생했습니다.", 500);
}

export async function POST(request: Request): Promise<Response> {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return errorResponse("올바른 파일 업로드 요청이 아닙니다.", 400);
  }

  const fileValue = formData.get("file");

  if (fileValue === null) {
    return errorResponse("음성 파일을 선택해주세요.", 400);
  }

  if (!(fileValue instanceof File)) {
    return errorResponse("업로드된 파일이 올바르지 않습니다.", 400);
  }

  if (fileValue.size <= 0) {
    return errorResponse("비어 있는 파일은 업로드할 수 없습니다.", 400);
  }

  if (!hasAllowedExtension(fileValue.name)) {
    return errorResponse(
      "m4a, mp3, wav 파일만 업로드할 수 있습니다.",
      400,
    );
  }

  const keywordParseResult = parseKeywords(formData.get("keywords"));

  if (!keywordParseResult.ok) {
    return errorResponse(keywordParseResult.error, 400);
  }

  try {
    const { id } = await createRtzrTranscription(
      fileValue,
      keywordParseResult.keywords,
    );

    return Response.json({ id }, { status: 201 });
  } catch (error: unknown) {
    return handleTranscriptionError(error);
  }
}
