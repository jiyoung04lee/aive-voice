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

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function hasAllowedExtension(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase();

  return extension !== undefined && ALLOWED_AUDIO_EXTENSIONS.has(extension);
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

  try {
    const { id } = await createRtzrTranscription(fileValue);

    return Response.json({ id }, { status: 201 });
  } catch (error: unknown) {
    return handleTranscriptionError(error);
  }
}
