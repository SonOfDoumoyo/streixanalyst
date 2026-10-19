"""Settings, read once from environment variables (see .env.example)."""
import json
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path):
    """Minimal .env loader (KEY=VALUE lines) so local runs work without extra packages."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_dotenv(BASE_DIR / ".env")


def env(name, default=None):
    v = os.environ.get(name)
    return default if v is None or v == "" else v


def env_bool(name, default=False):
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def env_int(name, default):
    try:
        return int(env(name, default))
    except (TypeError, ValueError):
        return default


class Settings:
    def __init__(self):
        self.app_name = "StreixAnalyst"
        self.env = env("ENV", "development")
        self.production = self.env == "production"
        secret = env("SECRET_KEY")
        if not secret:
            if self.production:
                raise RuntimeError("SECRET_KEY must be set in production (a long random string).")
            secret = secrets.token_urlsafe(48)          # dev only: sessions reset when the server restarts
        self.secret_key = secret
        self.frontend_url = env("FRONTEND_URL", "http://localhost:3000").rstrip("/")
        # public URL the browser uses for the API. Default: the frontend proxies /api to this server.
        self.public_api_url = env("PUBLIC_API_URL", self.frontend_url + "/api").rstrip("/")
        self.cors_origins = [o.strip().rstrip("/") for o in env("CORS_ORIGINS", self.frontend_url).split(",") if o.strip()]
        self.cookie_secure = env_bool("COOKIE_SECURE", self.production)
        self.cookie_domain = env("COOKIE_DOMAIN")
        self.cookie_samesite = env("COOKIE_SAMESITE", "lax")
        self.session_days = env_int("SESSION_DAYS", 30)
        # abuse protection (see docs/SECURITY.md): requests per minute from one address, the largest request body,
        # and whether the API's interactive docs are served in production
        self.api_rate_per_min = env_int("API_RATE_PER_MIN", 900)
        self.max_body_mb = env_int("MAX_BODY_MB", 8)
        self.enable_docs = env_bool("ENABLE_DOCS", not self.production)

        data_dir = Path(env("DATA_DIR", str(BASE_DIR / "data")))
        self.data_dir = data_dir
        db_url = env("DATABASE_URL", f"sqlite:///{data_dir / 'streix.db'}")
        if db_url.startswith("postgres://"):
            db_url = "postgresql+psycopg://" + db_url[len("postgres://"):]
        elif db_url.startswith("postgresql://"):
            db_url = "postgresql+psycopg://" + db_url[len("postgresql://"):]
        self.database_url = db_url
        self.cache_dir = Path(env("CACHE_DIR", str(data_dir / "cache")))
        self.upload_dir = Path(env("UPLOAD_DIR", str(data_dir / "uploads")))
        self.brain_path = Path(env("GURU_BRAIN_PATH", str(BASE_DIR / "models" / "guru_brain.joblib")))
        self.analysis_workers = env_int("ANALYSIS_WORKERS", 2)

        self.admin_email = (env("ADMIN_EMAIL") or "").strip().lower() or None
        self.admin_password = env("ADMIN_PASSWORD")
        self.trial_days = env_int("TRIAL_DAYS", 7)

        self.google_client_id = env("GOOGLE_CLIENT_ID")
        self.google_client_secret = env("GOOGLE_CLIENT_SECRET")
        self.linkedin_client_id = env("LINKEDIN_CLIENT_ID")
        self.linkedin_client_secret = env("LINKEDIN_CLIENT_SECRET")

        self.ai_provider = env("AI_PROVIDER", "auto")        # auto | anthropic | gemini | openai | offline
        self.anthropic_api_key = env("ANTHROPIC_API_KEY")
        self.anthropic_model = env("STREIXAI_MODEL", "claude-sonnet-5-5")
        self.anthropic_model_fast = env("STREIXAI_MODEL_FAST", "claude-haiku-5-5")
        self.openai_api_key = env("OPENAI_API_KEY")
        self.openai_base_url = env("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.openai_model = env("OPENAI_MODEL", "gpt-4o-mini")
        # Google Gemini (key from Google AI Studio). Free-plan users get the fast model.
        self.gemini_api_key = env("GEMINI_API_KEY")
        self.gemini_model = env("GEMINI_MODEL", "gemini-3.5-flash")
        self.gemini_model_fast = env("GEMINI_MODEL_FAST", self.gemini_model)
        self.gemini_base_url = env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
        self.ai_max_tokens = env_int("AI_MAX_TOKENS", 1200)

        self.paystack_secret_key = env("PAYSTACK_SECRET_KEY")
        self.paystack_public_key = env("PAYSTACK_PUBLIC_KEY")
        self.paystack_base_url = env("PAYSTACK_BASE_URL", "https://api.paystack.co").rstrip("/")
        self.paystack_dva_enabled = env_bool("PAYSTACK_DVA_ENABLED", False)
        self.paystack_dva_bank = env("PAYSTACK_DVA_BANK", "wema-bank")

        self.opay_merchant_id = env("OPAY_MERCHANT_ID")
        self.opay_public_key = env("OPAY_PUBLIC_KEY")
        self.opay_secret_key = env("OPAY_SECRET_KEY")
        self.opay_base_url = env("OPAY_BASE_URL", "https://liveapi.opaycheckout.com").rstrip("/")

        # USDT payments: the company wallet that receives them, the network, and a free block-explorer API key.
        self.crypto_network = (env("CRYPTO_NETWORK", "trc20") or "trc20").strip().lower()
        self.crypto_wallet_address = (env("CRYPTO_WALLET_ADDRESS") or "").strip() or None
        self.crypto_explorer_api_key = env("CRYPTO_EXPLORER_API_KEY")

        # bank accounts for manual transfers, e.g. MANUAL_ACCOUNTS='[{"bank":"OPay","number":"...","name":"..."}]'
        try:
            self.manual_accounts = json.loads(env("MANUAL_ACCOUNTS", "[]"))
        except json.JSONDecodeError:
            self.manual_accounts = []

        self.smtp_host = env("SMTP_HOST")
        self.smtp_port = env_int("SMTP_PORT", 587)
        self.smtp_user = env("SMTP_USER")
        self.smtp_password = env("SMTP_PASSWORD")
        self.smtp_from = env("SMTP_FROM", "StreixAnalyst <no-reply@streixanalyst.com>")

        self.cryptopanic_token = env("CRYPTOPANIC_TOKEN")
        self.enable_background = env_bool("ENABLE_BACKGROUND", True)

        # Phone alerts (Web push). Create the keys once (see .env.example), then set all three. Off until then.
        self.vapid_public_key = env("VAPID_PUBLIC_KEY")
        # the private key is PEM text. In a one-line .env value, write its line breaks as \n.
        self.vapid_private_key = (env("VAPID_PRIVATE_KEY") or "").replace("\\n", "\n") or None
        self.vapid_subject = env("VAPID_SUBJECT") or (f"mailto:{self.admin_email}" if self.admin_email else None)

        # Terms version people tick at sign-up. Change it when the Terms change, so the new version is recorded.
        self.terms_version = env("TERMS_VERSION", "2026-10-15")
        # Prices are in US dollars. Card and bank payments are taken in naira at this rate (₦ per $1).
        self.usd_ngn_rate = env_int("USD_NGN_RATE", 1550)
        # Public contact details, shown on the Contact page. Fill these in your .env.
        self.contact = dict(phone=env("CONTACT_PHONE", ""), email=env("CONTACT_EMAIL", ""),
                            company_email=env("CONTACT_COMPANY_EMAIL", ""), github=env("CONTACT_GITHUB", ""),
                            linkedin=env("CONTACT_LINKEDIN", ""))

    @property
    def google_enabled(self):
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def linkedin_enabled(self):
        return bool(self.linkedin_client_id and self.linkedin_client_secret)

    @property
    def paystack_enabled(self):
        return bool(self.paystack_secret_key)

    @property
    def opay_enabled(self):
        return bool(self.opay_merchant_id and self.opay_public_key and self.opay_secret_key)

    @property
    def crypto_enabled(self):
        return bool(self.crypto_wallet_address)

    @property
    def push_enabled(self):
        return bool(self.vapid_public_key and self.vapid_private_key and self.vapid_subject)


settings = Settings()
