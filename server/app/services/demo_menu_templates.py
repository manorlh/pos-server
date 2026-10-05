"""
The demo menus ("תפריט דמה", docs/SPEC_TRAINING_MODE.md) — data only.

One catalogue of demo content (categories with their products and prices, modifier
groups, product menus, meals, prep notes, courses and upsells) — the restaurant and bar
built for the "רויאל ספיריט" demo, plus a café. A template is the list of categories it
takes; everything else follows by name and is kept only when what it names is in the
template (app/services/demo_menu.py `plan`): a group's linked option whose product is not
there is dropped, a meal slot loses the products that are not there, an upsell whose
trigger or product is not there is not created, and a group nothing uses is not created.

Names are the keys: a product name is unique across the whole catalogue.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

#: (category, colour, [(product, price), …]) in till order.
CATEGORIES: List[Tuple[str, str, List[Tuple[str, float]]]] = [
    ("ראשונות", "#F59E0B", [("לחם הבית ומטבלים", 22), ("חומוס הבית", 34), ("כנפיים חריפות", 46), ("קלמרי מטוגן", 52), ("אדממה", 24)]),
    ("סלטים", "#22C55E", [("סלט קיסר", 52), ("סלט יווני", 48), ("סלט ירוק", 38)]),
    ("המבורגרים", "#EF4444", [("המבורגר קלאסי", 62), ("צ׳יזבורגר", 68), ("המבורגר כפול", 84), ("בורגר טבעוני", 64)]),
    ("עיקריות", "#B45309", [("סטייק אנטריקוט 300 גרם", 128), ("שניצל עוף", 62), ("פרגית על האש", 72), ("פילה סלמון", 92)]),
    ("פסטות ופיצות", "#F97316", [("פסטה רוזה", 58), ("פסטה עגבניות ובזיליקום", 52), ("פיצה מרגריטה", 54), ("פיצה פטריות", 62)]),
    ("תוספות", "#64748B", [("צ׳יפס", 18), ("בטטה צ׳יפס", 22), ("טבעות בצל", 22), ("פירה", 18), ("אורז", 16), ("סלט קטן", 16)]),
    ("קינוחים", "#EC4899", [("סופלה שוקולד", 42), ("עוגת גבינה", 38), ("קרם ברולה", 38), ("כדור גלידה", 14)]),
    ("ארוחות", "#8B5CF6", [("ארוחת המבורגר", 79), ("ארוחת שניצל", 74), ("ארוחת ילדים", 52), ("ארוחה זוגית", 169)]),
    ("שתייה קלה", "#0EA5E9", [("קוקה קולה", 14), ("קולה זירו", 14), ("ספרייט", 14), ("פאנטה", 14), ("מים מינרלים", 12), ("סודה", 12), ("לימונדה", 16), ("מיץ תפוזים סחוט", 18), ("תה קר", 14)]),
    ("שתייה חמה", "#92400E", [("אספרסו", 10), ("אספרסו כפול", 13), ("קפה הפוך", 14), ("קפוצ׳ינו", 15), ("אמריקנו", 12), ("תה", 12), ("שוקו חם", 16)]),
    ("בירות", "#EAB308", [("גולדסטאר מהחבית", 28), ("קרלסברג מהחבית", 32), ("גינס מהחבית", 36), ("היינקן בקבוק", 30), ("קורונה בקבוק", 30), ("בירה ללא אלכוהול", 22)]),
    ("קוקטיילים", "#DB2777", [("מוחיטו", 48), ("אפרול שפריץ", 46), ("נגרוני", 52), ("מרגריטה", 48), ("ג׳ין טוניק", 46), ("קוסמופוליטן", 48), ("וויסקי סאוור", 50)]),
    ("אלכוהול", "#7C3AED", [("ג׳יימסון", 34), ("ג׳וני ווקר בלאק לייבל", 42), ("גלנפידיך 12", 52), ("וודקה גריי גוס", 38), ("טקילה פטרון", 44), ("ערק", 26), ("צ׳ייסר וודקה", 18)]),
    ("יין", "#9F1239", [("יין אדום — כוס", 32), ("יין לבן — כוס", 32), ("רוזה — כוס", 34), ("קאווה — כוס", 34), ("בקבוק יין אדום", 130), ("בקבוק יין לבן", 120)]),
    # The café's own.
    ("ארוחות בוקר", "#CA8A04", [("ארוחת בוקר ישראלית", 72), ("שקשוקה", 54), ("ביצים בנדיקט", 58), ("גרנולה ויוגורט", 38), ("בוקר + קפה", 64), ("קפה ומאפה", 24)]),
    ("מאפים", "#D97706", [("קרואסון חמאה", 14), ("קרואסון שקדים", 18), ("מאפה גבינה", 16), ("עוגיית שוקולד צ׳יפס", 10), ("מאפין אוכמניות", 14)]),
    ("כריכים", "#65A30D", [("כריך טונה", 38), ("כריך חביתה", 34), ("כריך מוצרלה ופסטו", 40), ("טוסט גבינות", 36), ("בייגל סלמון", 46)]),
    ("שתייה קרה", "#06B6D4", [("אייס קפה", 18), ("אייס לאטה", 20), ("שייק בננה תמר", 24), ("ברד לימונענע", 16), ("מים בבקבוק", 10)]),
]


def opt(name: str, price: float = 0, **extra: Any) -> Dict[str, Any]:
    return {"name": name, "price": str(price), **extra}


def linked(name: str, price: float = 0, **extra: Any) -> Dict[str, Any]:
    """An option that is also a product of its own ("צ׳יפס" sold alone in "תוספות")."""
    return {"name": name, "price": str(price), "linked": name, **extra}


#: key → the group: `kind`, `options`, the `categories` it is assigned to, and its rules
#: (GroupIn's camelCase fields).
GROUPS: Dict[str, Dict[str, Any]] = {
    "burger_without": {"name": "בלי — המבורגר", "kind": "removal", "categories": ["המבורגרים"],
                       "options": [opt(n) for n in ["חסה", "עגבנייה", "בצל", "חמוצים", "רוטב", "גבינה"]]},
    "doneness": {"name": "מידת עשייה", "kind": "choice", "categories": ["המבורגרים"], "minSelect": 1, "maxSelect": 1,
                 "options": [opt("רייר"), opt("מדיום", isDefault=True), opt("מדיום-וול"), opt("וול דאן")]},
    "sauces": {"name": "רטבים", "kind": "addon", "categories": ["המבורגרים"], "allowPre": True,
               "options": [opt(n) for n in ["קטשופ", "מיונז", "איולי", "צ׳ילי מתוק", "ברביקיו", "חרדל"]]},
    "burger_extras": {"name": "תוספות להמבורגר", "kind": "addon", "categories": ["המבורגרים"], "allowQuantity": True,
                      "options": [opt("ביצת עין", 5, maxQty=2), opt("בייקון", 6, maxQty=2), opt("גבינה צהובה", 4, maxQty=2),
                                  opt("פטריות", 4, maxQty=2), opt("בצל מקורמל", 3, maxQty=2), opt("אבוקדו", 6, maxQty=2)]},
    # The sides are products of their own (sold alone in "תוספות"): the option is the product.
    "side": {"name": "תוספת בצד", "kind": "choice", "categories": ["המבורגרים"], "minSelect": 1, "maxSelect": 1,
             "options": [linked("צ׳יפס", isDefault=True), linked("בטטה צ׳יפס", 5), linked("טבעות בצל", 5),
                         linked("פירה"), linked("אורז"), linked("סלט קטן")]},
    "protein": {"name": "תוספת חלבון לסלט", "kind": "addon", "categories": ["סלטים"],
                "options": [opt("חזה עוף", 14), opt("סלמון", 18), opt("טונה", 12), opt("ביצה קשה", 5)]},
    "dressing": {"name": "רוטב לסלט", "kind": "choice", "categories": ["סלטים"], "maxSelect": 1, "allowPre": True,
                 "options": [opt("ויניגרט", isDefault=True), opt("שמן זית ולימון"), opt("יוגורט"), opt("קיסר")]},
    "pasta": {"name": "סוג פסטה", "kind": "choice", "minSelect": 1, "maxSelect": 1,
              "options": [opt("פנה", isDefault=True), opt("ספגטי"), opt("פטוצ׳יני"), opt("ניוקי", 6)]},
    "pizza": {"name": "תוספות לפיצה", "kind": "addon", "allowQuantity": True,
              "options": [opt(n, p, maxQty=2) for n, p in [("זיתים", 4), ("פטריות", 4), ("בצל", 3), ("תירס", 3), ("אנשובי", 6), ("גבינה כפולה", 8)]]},
    "spice": {"name": "חריפות", "kind": "choice", "maxSelect": 1,
              "options": [opt("עדין"), opt("חריף", isDefault=True), opt("חריף מאוד")]},
    "milk": {"name": "סוג חלב", "kind": "choice", "minSelect": 1, "maxSelect": 1,
             "options": [opt("רגיל", isDefault=True), opt("סויה"), opt("שקדים", 2), opt("שיבולת שועל", 2), opt("נטול לקטוז")]},
    "strength": {"name": "חוזק", "kind": "choice", "maxSelect": 1,
                 "options": [opt("חלש"), opt("רגיל", isDefault=True), opt("חזק"), opt("כפול", 3)]},
    "temp": {"name": "טמפרטורה", "kind": "choice", "categories": ["שתייה חמה"], "maxSelect": 1,
             "options": [opt("רותח"), opt("רגיל", isDefault=True), opt("פושר")]},
    "coffee_extras": {"name": "תוספות לקפה", "kind": "addon", "allowPre": True,
                      "options": [opt(n) for n in ["חלב", "קצף", "סוכר", "סוכרזית", "קינמון"]]},
    "coffee_without": {"name": "בלי — קפה", "kind": "removal", "options": [opt("קצף"), opt("סוכר")]},
    "soft_serve": {"name": "הגשה — שתייה", "kind": "addon", "categories": ["שתייה קלה"], "allowPre": True,
                   "options": [opt("קרח"), opt("לימון"), opt("נענע")]},
    "beer_size": {"name": "גודל בירה", "kind": "choice", "minSelect": 1, "maxSelect": 1,
                  "options": [opt("שליש", isDefault=True), opt("חצי", 6), opt("פיינט", 10)]},
    "cocktail_strength": {"name": "חוזק קוקטייל", "kind": "choice", "categories": ["קוקטיילים"], "maxSelect": 1,
                          "options": [opt("רגיל", isDefault=True), opt("כפול", 16)]},
    "cocktail_notes": {"name": "קוקטייל — התאמות", "kind": "addon", "categories": ["קוקטיילים"], "allowPre": True,
                       "options": [opt(n) for n in ["קרח", "סוכר", "נענע", "לימון"]]},
    "spirit_serve": {"name": "הגשת אלכוהול", "kind": "choice", "categories": ["אלכוהול"], "minSelect": 1, "maxSelect": 1,
                     "options": [opt("נקי", isDefault=True), opt("על קרח"), opt("עם קולה", 6), opt("עם סודה", 4), opt("עם רד בול", 12)]},
    "spirit_size": {"name": "גודל מנה", "kind": "choice", "categories": ["אלכוהול"], "minSelect": 1, "maxSelect": 1,
                    "options": [opt("רגיל", isDefault=True), opt("כפול", 20)]},
    "dessert_extras": {"name": "תוספת לקינוח", "kind": "addon", "categories": ["קינוחים"], "allowQuantity": True,
                       "options": [linked("כדור גלידה", 8, maxQty=2), opt("קצפת", 4), opt("רוטב שוקולד", 3)]},
    # The café's own.
    "bread": {"name": "סוג לחם", "kind": "choice", "categories": ["כריכים"], "minSelect": 1, "maxSelect": 1,
              "options": [opt("באגט", isDefault=True), opt("חלה"), opt("לחם מלא"), opt("ללא גלוטן", 4)]},
    "sandwich_extras": {"name": "תוספות לכריך", "kind": "addon", "categories": ["כריכים"], "allowQuantity": True,
                        "options": [opt("אבוקדו", 6, maxQty=2), opt("ביצה קשה", 4, maxQty=2), opt("גבינה צהובה", 4, maxQty=2), opt("ירקות קלויים", 5)]},
    "sandwich_without": {"name": "בלי — כריך", "kind": "removal", "categories": ["כריכים"],
                         "options": [opt(n) for n in ["עגבנייה", "מלפפון", "חסה", "בצל", "רוטב"]]},
    "eggs": {"name": "סוג ביצים", "kind": "choice", "minSelect": 1, "maxSelect": 1,
             "options": [opt("חביתה", isDefault=True), opt("עין"), opt("מקושקשת"), opt("עלומה", 2)]},
    "pastry_warm": {"name": "חימום מאפה", "kind": "choice", "categories": ["מאפים"], "maxSelect": 1,
                    "options": [opt("מחומם", isDefault=True), opt("לא מחומם")]},
}

#: The product's own groups (`groups`, in order; `None` = keep the category's), its own
#: note chips (`notes`: (text, important)), or `none` = "no modifiers" (stops the
#: category's). The products named are each given the same section.
PRODUCT_MENUS: List[Dict[str, Any]] = [
    {"products": ["המבורגר קלאסי", "צ׳יזבורגר", "המבורגר כפול", "בורגר טבעוני"],
     "notes": [("להכין ראשון", False), ("חתוך לחצי", False), ("רוטב בצד", False), ("בלי מלח", False), ("עשוי היטב", False)]},
    {"products": ["סטייק אנטריקוט 300 גרם"], "groups": ["doneness", "sauces", "side"],
     "notes": [("חתוך לפרוסות", False), ("רוטב בצד", False), ("להגיש עם העיקריות", False)]},
    {"products": ["שניצל עוף"], "groups": ["sauces", "side"], "notes": [("בלי פירורים בצד", False), ("חתוך לרצועות", False)]},
    {"products": ["פרגית על האש"], "groups": ["sauces", "side", "spice"]},
    {"products": ["פילה סלמון"], "groups": ["side"], "notes": [("עשוי היטב", False), ("רוטב בצד", False)]},
    {"products": ["פסטה רוזה", "פסטה עגבניות ובזיליקום"], "groups": ["pasta"], "notes": [("בלי פרמזן", False), ("חריף", False)]},
    {"products": ["פיצה מרגריטה", "פיצה פטריות"], "groups": ["pizza"], "notes": [("פריכה", False), ("חתוך ל-8", False)]},
    {"products": ["כנפיים חריפות"], "groups": ["spice", "sauces"]},
    {"products": ["קפה הפוך", "קפוצ׳ינו"], "groups": ["milk", "strength", "temp", "coffee_extras", "coffee_without"],
     "notes": [("בכוס זכוכית", False), ("בכוס חד פעמית", False), ("לקחת", False), ("על קרח", False), ("חלב בצד", False)]},
    {"products": ["אמריקנו"], "groups": ["strength", "temp", "coffee_extras"],
     "notes": [("בכוס זכוכית", False), ("בכוס חד פעמית", False), ("לקחת", False), ("על קרח", False), ("חלב בצד", False)]},
    {"products": ["אספרסו", "אספרסו כפול"], "groups": ["coffee_extras"], "notes": [("בכוס זכוכית", False), ("קצר", False), ("ארוך", False)]},
    {"products": ["תה"], "groups": ["temp", "coffee_extras"], "notes": [("נענע טרייה", False), ("לימון בצד", False)]},
    {"products": ["שוקו חם"], "groups": ["milk", "temp"]},
    {"products": ["גולדסטאר מהחבית", "קרלסברג מהחבית", "גינס מהחבית"], "groups": ["beer_size"]},
    {"products": ["צ׳ייסר וודקה"], "none": True},
    {"products": ["כדור גלידה"], "none": True},
    {"products": ["מוחיטו", "נגרוני", "מרגריטה"], "notes": [("בלי קש", False), ("בכוס גבוהה", False), ("בלי מלח על השפה", False)]},
    # The café's own.
    {"products": ["ארוחת בוקר ישראלית", "שקשוקה"], "groups": ["eggs"], "notes": [("בלי בצל", False), ("לחם בצד", False), ("חריף", False)]},
    {"products": ["אייס קפה", "אייס לאטה"], "groups": ["milk", "coffee_extras"], "notes": [("בלי קרח", False), ("לקחת", False)]},
]

#: meal product → its slots. Each option is (product, upcharge, default).
MEALS: Dict[str, List[Dict[str, Any]]] = {
    "ארוחת המבורגר": [
        {"name": "המבורגר", "options": [("המבורגר קלאסי", 0, True), ("צ׳יזבורגר", 6, False), ("המבורגר כפול", 20, False), ("בורגר טבעוני", 0, False)]},
        {"name": "תוספת", "options": [("צ׳יפס", 0, True), ("בטטה צ׳יפס", 4, False), ("טבעות בצל", 4, False), ("סלט קטן", 0, False)]},
        {"name": "שתייה", "options": [("קוקה קולה", 0, True), ("קולה זירו", 0, False), ("ספרייט", 0, False), ("פאנטה", 0, False),
                                      ("מים מינרלים", 0, False), ("לימונדה", 2, False), ("גולדסטאר מהחבית", 12, False)]},
    ],
    "ארוחת שניצל": [
        {"name": "שתי תוספות", "quantity": 2, "minSelect": 2, "maxSelect": 2, "allowRepeat": True,
         "options": [("צ׳יפס", 0, False), ("פירה", 0, False), ("אורז", 0, False), ("סלט קטן", 0, False)]},
        {"name": "שתייה", "options": [("קוקה קולה", 0, True), ("קולה זירו", 0, False), ("ספרייט", 0, False), ("פאנטה", 0, False),
                                      ("מים מינרלים", 0, False), ("לימונדה", 2, False), ("גולדסטאר מהחבית", 12, False)]},
    ],
    "ארוחת ילדים": [
        {"name": "מנה", "options": [("שניצל עוף", 0, True), ("המבורגר קלאסי", 0, False)]},
        {"name": "תוספת", "options": [("צ׳יפס", 0, True), ("פירה", 0, False), ("אורז", 0, False)]},
        {"name": "שתייה", "options": [("קוקה קולה", 0, True), ("ספרייט", 0, False), ("מיץ תפוזים סחוט", 2, False), ("מים מינרלים", 0, False)]},
        {"name": "קינוח", "options": [("כדור גלידה", 0, True)]},
    ],
    "ארוחה זוגית": [
        {"name": "שני המבורגרים", "quantity": 2, "minSelect": 2, "maxSelect": 2, "allowRepeat": True,
         "options": [("המבורגר קלאסי", 0, False), ("צ׳יזבורגר", 6, False), ("המבורגר כפול", 20, False), ("בורגר טבעוני", 0, False)]},
        {"name": "שתי תוספות", "quantity": 2, "minSelect": 2, "maxSelect": 2, "allowRepeat": True,
         "options": [("צ׳יפס", 0, True), ("בטטה צ׳יפס", 4, False), ("טבעות בצל", 4, False), ("סלט קטן", 0, False)]},
        {"name": "שתי שתיות", "quantity": 2, "minSelect": 2, "maxSelect": 2, "allowRepeat": True,
         "options": [("קוקה קולה", 0, True), ("קולה זירו", 0, False), ("ספרייט", 0, False), ("פאנטה", 0, False),
                     ("מים מינרלים", 0, False), ("לימונדה", 2, False), ("גולדסטאר מהחבית", 12, False)]},
    ],
    # The café's own.
    "בוקר + קפה": [
        {"name": "מנה", "options": [("שקשוקה", 0, True), ("ביצים בנדיקט", 4, False), ("ארוחת בוקר ישראלית", 12, False), ("גרנולה ויוגורט", 0, False)]},
        {"name": "שתייה חמה", "options": [("קפה הפוך", 0, True), ("אמריקנו", 0, False), ("קפוצ׳ינו", 1, False), ("תה", 0, False)]},
    ],
    "קפה ומאפה": [
        {"name": "קפה", "options": [("קפה הפוך", 0, True), ("אמריקנו", 0, False), ("אספרסו", 0, False)]},
        {"name": "מאפה", "options": [("קרואסון חמאה", 0, True), ("קרואסון שקדים", 3, False), ("מאפה גבינה", 1, False)]},
    ],
}

#: The chips every dish gets (the company's "הערות לכל מנה").
GLOBAL_NOTES: List[Tuple[str, bool]] = [
    ("אלרגיה לאגוזים", True), ("ללא גלוטן", True), ("צמחוני", False),
    ("להגיש יחד", False), ("דחוף", True), ("ללא מלח", False),
]

#: The courses ("סדר הגשה"), in order, and which category is served in which.
COURSES: List[str] = ["ראשונות", "עיקריות", "קינוחים"]
CATEGORY_COURSES: Dict[str, str] = {
    "ראשונות": "ראשונות", "סלטים": "ראשונות", "המבורגרים": "עיקריות", "עיקריות": "עיקריות",
    "פסטות ופיצות": "עיקריות", "ארוחות": "עיקריות", "קינוחים": "קינוחים", "ארוחות בוקר": "עיקריות",
}

#: Upsells ("הצעות מכירה"): triggered by a category, adding a product. `templates`
#: limits one to those templates (absent: every template that has what it names).
UPSELLS: List[Dict[str, Any]] = [
    {"name": "טבעות בצל להמבורגר", "trigger": "המבורגרים", "product": "טבעות בצל", "message": "להוסיף טבעות בצל?"},
    {"name": "עוגה ליד הקפה", "trigger": "שתייה חמה", "product": "עוגת גבינה", "message": "עוגת גבינה ליד הקפה?",
     "templates": ["restaurant", "restaurant_bar"]},
    {"name": "מאפה ליד הקפה", "trigger": "שתייה חמה", "product": "קרואסון חמאה", "message": "קרואסון חם ליד הקפה?",
     "templates": ["cafe"]},
    {"name": "צ׳ייסר ליד הבירה", "trigger": "בירות", "product": "צ׳ייסר וודקה", "message": "צ׳ייסר ליד הבירה?",
     "templates": ["bar"]},
]

#: The templates: the categories each takes, in till order.
TEMPLATES: Dict[str, Dict[str, Any]] = {
    "restaurant": {
        "name": "מסעדה",
        "description": "ראשונות, סלטים, המבורגרים, עיקריות, פסטות ופיצות, תוספות, קינוחים, ארוחות, שתייה ויין.",
        "categories": ["ראשונות", "סלטים", "המבורגרים", "עיקריות", "פסטות ופיצות", "תוספות", "קינוחים", "ארוחות",
                       "שתייה קלה", "שתייה חמה", "יין"],
    },
    "bar": {
        "name": "בר",
        "description": "בירות מהחבית, קוקטיילים, אלכוהול, יין, שתייה קלה ונשנושים.",
        "categories": ["ראשונות", "בירות", "קוקטיילים", "אלכוהול", "יין", "שתייה קלה"],
    },
    "cafe": {
        "name": "בית קפה",
        "description": "ארוחות בוקר, מאפים, כריכים, סלטים, קינוחים, שתייה חמה וקרה.",
        "categories": ["ארוחות בוקר", "מאפים", "כריכים", "סלטים", "קינוחים", "שתייה חמה", "שתייה קרה"],
    },
    "restaurant_bar": {
        "name": "מסעדה ובר",
        "description": "התפריט המלא של ההדגמה ברויאל ספיריט: המטבח והבר יחד.",
        "categories": ["ראשונות", "סלטים", "המבורגרים", "עיקריות", "פסטות ופיצות", "תוספות", "קינוחים", "ארוחות",
                       "שתייה קלה", "שתייה חמה", "בירות", "קוקטיילים", "אלכוהול", "יין"],
    },
}
