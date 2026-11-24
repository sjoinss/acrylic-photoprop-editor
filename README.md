# 포토프랍 PDF 에디터

이미지를 올리면 아크릴 포토프랍 인쇄용 PDF(화이트 · 이미지 · 칼선 레이어, 1:1 mm)를 만드는 웹 에디터예요.
서버 없이 브라우저 안에서만 처리하고, 외부 라이브러리를 쓰지 않아요.

- 실행: `index.html`을 열기 (단일 파일)
- 수정: `src/`를 고친 뒤 `node build.cjs`
- 테스트: `node --test test/core.test.cjs`

| 파일 | 내용 |
|---|---|
| `src/core.js` | 거리 변환, 윤곽선, 칼선·화이트 생성, 검증, PDF 작성기 |
| `src/worker.js` | 계산 워커 |
| `src/app.js` | 화면과 편집 |
