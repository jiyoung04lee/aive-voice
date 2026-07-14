import {
  getRtzrTranscriptionStatus,
  RtzrAuthenticationError,
  RtzrAuthResponseError,
  RtzrConfigurationError,
  RtzrHttpError,
  RtzrTranscriptionStatusError,
  RtzrTranscriptionStatusHttpError,
  RtzrTranscriptionStatusResponseError,
} from "@/lib/rtzr";

const TRANSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function handleStatusError(error: unknown): Response {
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

  if (error instanceof RtzrTranscriptionStatusError) {
    if (error.status === 400) {
      return errorResponse("올바르지 않은 전사 작업 ID입니다.", 400);
    }

    if (error.status === 401) {
      return errorResponse(
        "음성 전사 서비스 인증 중 오류가 발생했습니다.",
        502,
      );
    }

    if (error.status === 403) {
      return errorResponse("전사 작업을 조회할 수 없습니다.", 403);
    }

    if (error.status === 404) {
      return errorResponse("전사 작업을 찾을 수 없습니다.", 404);
    }

    if (error.status === 410) {
      return errorResponse("전사 작업 결과가 만료되었습니다.", 410);
    }

    return errorResponse("음성 전사 작업 조회 중 오류가 발생했습니다.", 502);
  }

  if (
    error instanceof RtzrTranscriptionStatusHttpError ||
    error instanceof RtzrTranscriptionStatusResponseError
  ) {
    return errorResponse("음성 전사 작업 조회 중 오류가 발생했습니다.", 502);
  }

  return errorResponse("요청을 처리하는 중 오류가 발생했습니다.", 500);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  if (!id?.trim() || !TRANSCRIPTION_ID_PATTERN.test(id)) {
    return errorResponse("올바르지 않은 전사 작업 ID입니다.", 400);
  }

  try {
    const result = await getRtzrTranscriptionStatus(id);

    if (result.status === "transcribing") {
      return Response.json({ status: result.status });
    }

    if (result.status === "failed") {
      return Response.json({
        status: result.status,
        error: "음성 전사 작업에 실패했습니다.",
      });
    }

    return Response.json({
      status: result.status,
      utterances: result.results.utterances,
    });
  } catch (error: unknown) {
    return handleStatusError(error);
  }
}
