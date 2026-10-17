from loopkeeper.api import Settings

TOKEN = "test-token-operator-0123456789"
VIEWER = "test-token-viewer-0123456789"
OTHER = "test-token-other-run-0123456789"


def make_settings(**kw) -> Settings:
    base = dict(
        env="dev",
        auth_disabled=False,
        api_auth_token=TOKEN,
        api_tokens=f"{VIEWER}:viewer1:viewer,{OTHER}:other:operator:run_elsewhere",
        enable_test_commands=True,
    )
    base.update(kw)
    return Settings(**base)
