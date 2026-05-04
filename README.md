# Pi Extensions

로컬에서 개발/관리하는 Pi extension package입니다.

## 다른 프로젝트에서 package로 사용하기

이 레포를 다른 프로젝트에서 Pi package로 참조하려면 대상 프로젝트의 `.pi/settings.json`에 `packages`로 등록합니다.

### 절대 경로로 등록

```json
{
  "packages": [
    "/path/to/pi-extensions"
  ]
}
```

### 상대 경로로 등록

`.pi/settings.json`에서 상대 경로는 프로젝트 루트가 아니라 `.pi/` 디렉토리 기준입니다.

예를 들어 구조가 다음과 같다면:

```text
workspace/
├── my-project/
│   └── .pi/
│       └── settings.json
└── pi-extensions/
```

`my-project/.pi/settings.json`에서는 다음처럼 씁니다.

```json
{
  "packages": [
    "../../pi-extensions"
  ]
}
```

### package로 등록하면서 extensions만 명시하기

package 전체를 등록하되, 로드할 extension 파일을 직접 지정하려면 `packages` 항목을 object 형태로 작성합니다. 여러 extension을 한 번에 로드하려면 glob pattern을 사용할 수 있습니다.

```json
{
  "packages": [
    {
      "source": "/path/to/pi-extensions",
      "extensions": [
        "extensions/*.ts"
      ],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

상대 경로를 사용할 수도 있습니다.

```json
{
  "packages": [
    {
      "source": "../../pi-extensions",
      "extensions": [
        "extensions/*.ts"
      ],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

`source`는 `.pi/settings.json` 기준 package 경로이고, `extensions` 안의 경로는 package root 기준입니다.

특정 파일을 제외하려면 `!` pattern을 추가할 수 있습니다.

```json
{
  "packages": [
    {
      "source": "../../pi-extensions",
      "extensions": [
        "extensions/*.ts",
        "!extensions/<excluded-file>.ts"
      ],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

---

## pi install로 등록하기

대상 프로젝트에서 아래처럼 로컬 package 경로를 설치할 수도 있습니다.

```bash
pi install /path/to/pi-extensions -l
```

`-l` 옵션은 현재 프로젝트의 `.pi/settings.json`에 package를 등록합니다.

등록 후에는 `.pi/settings.json`에 대략 다음과 같은 형태가 추가됩니다.

```json
{
  "packages": [
    "/path/to/pi-extensions"
  ]
}
```

---

## 적용 후 확인

Pi를 이미 실행 중이었다면 reload가 필요할 수 있습니다.

Pi 안에서:

```text
/reload
```

또는 Pi를 재시작합니다.

이후 package에 포함된 Pi resource가 로드됩니다.
