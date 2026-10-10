"""
A fresh VAPID key pair for "התראות לטלפון" (Web Push), printed as the two env lines to paste
into the server's environment (`.env` locally) — never into the repository:

    python -m scripts.generate_vapid_keys

Changing the pair later makes every existing browser subscription invalid (they were made
for the old public key): the dashboard then asks each device to subscribe again.
"""
from app.services.webpush import generate_vapid_keys


def main() -> None:
    private, public = generate_vapid_keys()
    print(f"WEBPUSH_VAPID_PUBLIC_KEY={public}")
    print(f"WEBPUSH_VAPID_PRIVATE_KEY={private}")


if __name__ == "__main__":
    main()
