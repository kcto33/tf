from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = ROOT / "output" / "pdf" / "filetransfer_app_summary.pdf"


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="TitleSmall",
            parent=styles["Normal"],
            fontName="Helvetica-Bold",
            fontSize=10,
            leading=12,
            textColor=colors.HexColor("#8B4B24"),
            spaceAfter=2,
        )
    )
    styles.add(
        ParagraphStyle(
            name="TitleMain",
            parent=styles["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=21,
            leading=24,
            textColor=colors.HexColor("#1F1813"),
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="Intro",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=9.6,
            leading=12,
            textColor=colors.HexColor("#4A4038"),
            spaceAfter=0,
        )
    )
    styles.add(
        ParagraphStyle(
            name="Banner",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=9.6,
            leading=12,
            textColor=colors.HexColor("#4A4038"),
            spaceAfter=0,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SectionTitle",
            parent=styles["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=13,
            textColor=colors.HexColor("#8B4B24"),
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BodyCompact",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=8.6,
            leading=11,
            textColor=colors.HexColor("#1F1813"),
            spaceAfter=3,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BulletCompact",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=8.4,
            leading=10.4,
            textColor=colors.HexColor("#1F1813"),
            leftIndent=10,
            firstLineIndent=-7,
            bulletIndent=0,
            spaceAfter=2,
        )
    )
    styles.add(
        ParagraphStyle(
            name="Footer",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=7.3,
            leading=8.7,
            textColor=colors.HexColor("#6B5B4F"),
            alignment=1,
        )
    )
    return styles


def card(title: str, body: list[Paragraph], styles) -> Table:
    content = [Paragraph(title, styles["SectionTitle"]), Spacer(1, 1.5 * mm), *body]
    table = Table([[content]], colWidths=[83 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF9F1")),
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#D8C8B7")),
                ("ROUNDEDCORNERS", (0, 0), (-1, -1), 10),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def stack(items: list, width_mm: float) -> Table:
    rows = [[item] for item in items]
    table = Table(rows, colWidths=[width_mm * mm])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
            ]
        )
    )
    return table


def bullet(text: str, styles) -> Paragraph:
    return Paragraph(text, styles["BulletCompact"], bulletText="•")


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    styles = build_styles()
    doc = SimpleDocTemplate(
        str(OUTPUT_PATH),
        pagesize=A4,
        leftMargin=13 * mm,
        rightMargin=13 * mm,
        topMargin=12 * mm,
        bottomMargin=10 * mm,
        title="FileTransfer App Summary",
        author="Codex",
    )

    intro = Table(
        [
            [[
                Paragraph(
                    "<font name='Helvetica-Bold' size='10' color='#8B4B24'>REPO-BACKED APP SUMMARY</font><br/>"
                    "<font name='Helvetica-Bold' size='21' color='#1F1813'>FileTransfer</font><br/>"
                    "A browser-based LAN file transfer app built with FastAPI, WebSocket signaling, "
                    "and WebRTC DataChannels. Multiple PCs join the same room, discover peers, and "
                    "send files directly browser-to-browser while the server coordinates signaling only.",
                    styles["Banner"],
                ),
            ]]
        ],
        colWidths=[184 * mm],
    )
    intro.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F4E8D8")),
                ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#C9AD91")),
                ("ROUNDEDCORNERS", (0, 0), (-1, -1), 14),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ]
        )
    )

    left_cards = [
        card(
            "What It Is",
            [
                Paragraph(
                    "A local-network web app for peer-to-peer file transfer, with an optional Windows tray "
                    "launcher for packaged desktop use.",
                    styles["BodyCompact"],
                )
            ],
            styles,
        ),
        card(
            "Who It's For",
            [
                Paragraph(
                    "Primary persona: <b>Not found in repo.</b> Inferred from the README and UI: users on the same "
                    "LAN who need quick ad hoc PC-to-PC transfer in a browser.",
                    styles["BodyCompact"],
                )
            ],
            styles,
        ),
        card(
            "How to Run",
            [
                bullet("Create and activate a virtual environment.", styles),
                bullet("Install dependencies with <b>pip install -r requirements.txt</b>.", styles),
                bullet(
                    "Start the app with <b>uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload</b>.",
                    styles,
                ),
                bullet(
                    "Open <b>http://127.0.0.1:8000</b>; use the machine's LAN IP for another PC on the same network.",
                    styles,
                ),
            ],
            styles,
        ),
    ]

    right_cards = [
        card(
            "What It Does",
            [
                bullet("Lets devices join a shared room with a room code and display name.", styles),
                bullet("Shows online peers and allows choosing a specific transfer target.", styles),
                bullet("Supports files, folders, and drag-and-drop selection.", styles),
                bullet("Requires receiver approval before a transfer begins.", styles),
                bullet("Transfers file data browser-to-browser over an ordered WebRTC DataChannel.", styles),
                bullet("Stores local history and incomplete incoming chunks in IndexedDB for resume-after-refresh.", styles),
                bullet("Downloads one file directly or bundles multi-file transfers into a browser-built ZIP.", styles),
            ],
            styles,
        ),
        card(
            "How It Works",
            [
                bullet(
                    "FastAPI serves <b>/</b>, <b>/static</b>, and <b>/health</b>; the frontend lives in "
                    "<b>static/index.html</b>, <b>styles.css</b>, and <b>app.js</b>.",
                    styles,
                ),
                bullet(
                    "A WebSocket endpoint at <b>/ws/signaling</b> keeps in-memory room membership and relays join/leave, "
                    "offer/answer, ICE, transfer, and resume messages through <b>RoomHub</b>.",
                    styles,
                ),
                bullet(
                    "Each browser creates an <b>RTCPeerConnection</b> per peer plus one ordered <b>file-transfer</b> "
                    "DataChannel used for chat messages, file metadata, and binary chunks.",
                    styles,
                ),
                bullet(
                    "Incoming session metadata and chunks are stored in IndexedDB (<b>sessions</b>, <b>chunks</b>); "
                    "the browser reassembles files locally and creates ZIP output for multi-file sessions.",
                    styles,
                ),
                bullet(
                    "For packaged Windows use, <b>launcher.py</b> starts a bundled server, exposes local/LAN URLs, "
                    "manages startup registration, and runs from the system tray.",
                    styles,
                ),
            ],
            styles,
        ),
    ]

    columns = Table(
        [[stack(left_cards, 89), stack(right_cards, 89)]],
        colWidths=[89 * mm, 89 * mm],
    )
    columns.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    footer = Paragraph(
        "Evidence used: README.md, app/main.py, server_entry.py, launcher.py, static/index.html, static/app.js",
        styles["Footer"],
    )

    story = [
        intro,
        Spacer(1, 4 * mm),
        columns,
        Spacer(1, 2.5 * mm),
        footer,
    ]
    doc.build(story)


if __name__ == "__main__":
    main()
