"""Editable PowerPoint renderer for validated Presentation Design Schema v1."""

from __future__ import annotations

from io import BytesIO
from typing import Any

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt

from tools.presentation_design import CANVAS, SAFE_MARGIN, PresentationDesign, SlideDesign, resolve_theme
from tools.pexels import PexelsPhoto


def _color(value: str) -> RGBColor:
    clean = value.lstrip("#")
    return RGBColor.from_string(clean.upper())


def _set_font(run, theme: dict[str, Any], size: float, color: str, bold: bool = False) -> None:
    run.font.name = theme["font"]
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = _color(color)


def _text(slide, x: float, y: float, w: float, h: float, value: str, theme: dict[str, Any], *, size: float = 18,
          color: str | None = None, bold: bool = False, align=PP_ALIGN.LEFT, valign=MSO_ANCHOR.MIDDLE,
          margin: float = 0.02) -> Any:
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.margin_left = Inches(margin)
    tf.margin_right = Inches(margin)
    tf.margin_top = Inches(margin)
    tf.margin_bottom = Inches(margin)
    tf.vertical_anchor = valign
    para = tf.paragraphs[0]
    para.alignment = align
    para.space_after = Pt(0)
    run = para.add_run()
    run.text = value
    _set_font(run, theme, size, color or theme["textPrimary"], bold)
    return box


def _shape(slide, x: float, y: float, w: float, h: float, fill: str, *, rounded: bool = True,
           line: str | None = None, transparency: int = 0) -> Any:
    kind = MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(kind, Inches(x), Inches(y), Inches(w), Inches(h))
    shape.fill.solid()
    shape.fill.fore_color.rgb = _color(fill)
    if transparency:
        # python-pptx does not serialize FillFormat.transparency. Add DrawingML
        # alpha to the actual color element so the photo below remains visible.
        alpha = OxmlElement("a:alpha")
        alpha.set("val", str(max(0, min(100000, round((100 - transparency) * 1000)))))
        shape._element.spPr.solidFill.srgbClr.append(alpha)
    shape.line.color.rgb = _color(line or fill)
    shape.line.width = Pt(0.7)
    return shape


def _add_cropped_photo(slide, photo: PexelsPhoto, x: float, y: float, w: float, h: float):
    stream = BytesIO(photo.image_bytes)
    picture = slide.shapes.add_picture(stream, Inches(x), Inches(y), width=Inches(w), height=Inches(h))
    source_ratio = picture.image.size[0] / picture.image.size[1]
    target_ratio = w / h
    if source_ratio > target_ratio:
        visible_width = target_ratio / source_ratio
        picture.crop_left = picture.crop_right = (1 - visible_width) / 2
    elif source_ratio < target_ratio:
        visible_height = source_ratio / target_ratio
        picture.crop_top = picture.crop_bottom = (1 - visible_height) / 2
    return picture


def _background(slide, theme: dict[str, Any], width: float, height: float, index: int,
                photo: PexelsPhoto | None = None) -> None:
    fill = slide.background.fill
    fill.gradient()
    fill.gradient_angle = 45 if index % 2 == 0 else 315
    fill.gradient_stops[0].color.rgb = _color(theme["background"])
    fill.gradient_stops[1].color.rgb = _color(theme.get("gradientEnd", theme["background"]))
    if photo:
        _add_cropped_photo(slide, photo, 0, 0, width, height)
        is_dark_theme = theme["background"] in {"111827", "0B1020"}
        overlay = _shape(slide, 0, 0, width, height, theme["background"], rounded=False,
                         transparency=45 if is_dark_theme else 35)
        overlay.line.fill.background()
    # Gradient alone is the dark/technology backdrop. Large decorative blocks
    # compete with slide content, so reserve extra geometry for the foreground.
    if theme["decorations"] == "rule":
        _shape(slide, SAFE_MARGIN, 0.28, 0.62, 0.055, theme["accent"], rounded=False)
    elif theme["decorations"] == "soft":
        _shape(slide, width - 1.35, 0.34, 0.55, 0.055, theme["accent"], rounded=False)


def _header(slide, design: SlideDesign, theme: dict[str, Any], width: float, *, title_size: float = 30) -> float:
    if design.eyebrow:
        _text(slide, SAFE_MARGIN, 0.38, width - 2 * SAFE_MARGIN, 0.24, design.eyebrow.upper(), theme, size=10, color=theme["accent"], bold=True)
    title_y = 0.72 if design.eyebrow else 0.55
    _text(slide, SAFE_MARGIN, title_y, width - 2 * SAFE_MARGIN, 0.62, design.title or "", theme, size=title_size, bold=True)
    if design.subtitle:
        _text(slide, SAFE_MARGIN, title_y + 0.66, width - 2 * SAFE_MARGIN, 0.42, design.subtitle, theme, size=15, color=theme["textSecondary"])
        return title_y + 1.25
    return title_y + 0.88


def _body_points(slide, design: SlideDesign, theme: dict[str, Any], *, x: float, y: float, w: float, h: float, size: float = 19) -> None:
    items = design.supportingPoints or ([design.keyMessage] if design.keyMessage else [])
    if not items:
        return
    gap = min(0.82, h / max(1, len(items)))
    for index, point in enumerate(items):
        yy = y + index * gap
        _shape(slide, x, yy + 0.18, 0.09, 0.09, theme["accent"], rounded=True)
        _text(slide, x + 0.22, yy, w - 0.22, max(0.34, gap - 0.08), point, theme, size=size, color=theme["textSecondary"], valign=MSO_ANCHOR.TOP)


def _metric_cards(slide, design: SlideDesign, theme: dict[str, Any], width: float, top: float, *, hero: bool = False) -> None:
    metrics = design.metrics
    if not metrics:
        return
    count = len(metrics)
    gap = 0.18
    columns = 1 if hero or count == 1 else 2
    card_w = (width - 2 * SAFE_MARGIN - gap * (columns - 1)) / columns
    card_h = 2.05 if hero else 1.82
    for index, metric in enumerate(metrics):
        col, row = index % columns, index // columns
        x, y = SAFE_MARGIN + col * (card_w + gap), top + row * (card_h + gap)
        _shape(slide, x, y, card_w, card_h, theme["surface"], line=theme["border"])
        _text(slide, x + 0.2, y + 0.2, card_w - 0.4, 0.3, metric.label, theme, size=13, color=theme["textSecondary"])
        _text(slide, x + 0.2, y + 0.55, card_w - 0.4, 0.7, metric.value, theme,
              size=34 if hero or index == 0 and design.type == "big-number" else 27, color=theme["primary"], bold=True)
        if metric.note:
            _text(slide, x + 0.2, y + 1.31, card_w - 0.4, 0.38, metric.note, theme, size=11, color=theme["muted"], valign=MSO_ANCHOR.TOP)


def _chart(slide, design: SlideDesign, theme: dict[str, Any], width: float, top: float, height: float) -> None:
    chart_data = design.chart
    if not chart_data:
        return
    data = CategoryChartData()
    data.categories = chart_data.categories
    for series in chart_data.series:
        data.add_series(series.name, series.values)
    chart_kind = {
        "bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
        "line": XL_CHART_TYPE.LINE_MARKERS,
        "area": XL_CHART_TYPE.AREA,
        "donut": XL_CHART_TYPE.DOUGHNUT,
    }[chart_data.type]
    chart_shape = slide.shapes.add_chart(
        chart_kind,
        Inches(SAFE_MARGIN + 0.08), Inches(top), Inches(width - 2 * SAFE_MARGIN - 0.16), Inches(height), data,
    )
    chart = chart_shape.chart
    chart.chart_style = 10
    chart.has_legend = len(chart_data.series) > 1 or chart_data.type == "donut"
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
        chart.legend.font.name = theme["font"]
        chart.legend.font.size = Pt(10)
    if chart_data.type != "donut":
        chart.value_axis.has_major_gridlines = True
        chart.value_axis.tick_labels.font.name = theme["font"]
        chart.value_axis.tick_labels.font.size = Pt(10)
        chart.category_axis.tick_labels.font.name = theme["font"]
        chart.category_axis.tick_labels.font.size = Pt(10)
        for series_index, series in enumerate(chart.series):
            series.format.fill.solid()
            series.format.fill.fore_color.rgb = _color(theme["primary"] if series_index == 0 else theme["accent"])


def _table(slide, design: SlideDesign, theme: dict[str, Any], width: float, top: float, height: float) -> None:
    spec = design.table
    if not spec:
        return
    table = slide.shapes.add_table(
        len(spec.rows) + 1, len(spec.headers), Inches(SAFE_MARGIN), Inches(top),
        Inches(width - 2 * SAFE_MARGIN), Inches(height),
    ).table
    for column, heading in enumerate(spec.headers):
        cell = table.cell(0, column)
        cell.text = heading
        cell.fill.solid()
        cell.fill.fore_color.rgb = _color(theme["primary"])
        for run in cell.text_frame.paragraphs[0].runs:
            _set_font(run, theme, 12, "FFFFFF", True)
    for row_index, row_data in enumerate(spec.rows, start=1):
        for column, value in enumerate(row_data):
            cell = table.cell(row_index, column)
            cell.text = value
            cell.fill.solid()
            fill = theme["surface"] if row_index % 2 else theme["background"]
            if row_index - 1 in spec.highlightRows or column in spec.highlightColumns:
                fill = theme["accent"]
            cell.fill.fore_color.rgb = _color(fill)
            cell.margin_left = Inches(0.08)
            cell.margin_right = Inches(0.08)
            for run in cell.text_frame.paragraphs[0].runs:
                _set_font(run, theme, 11, theme["textPrimary"], column == 0)


def _visual_panel(slide, design: SlideDesign, theme: dict[str, Any], x: float, y: float, w: float, h: float,
                  photo: PexelsPhoto | None = None) -> None:
    """Deterministic vector visual fallback; never stretches or invents a photo asset."""
    if photo:
        _add_cropped_photo(slide, photo, x, y, w, h)
        return
    _shape(slide, x, y, w, h, theme["surface"], line=theme["border"])
    _shape(slide, x + 0.32, y + 0.36, w * 0.48, h * 0.12, theme["primary"])
    _shape(slide, x + 0.32, y + 0.62, w * 0.31, h * 0.07, theme["accent"])
    _shape(slide, x + w * 0.62, y + h * 0.2, w * 0.22, h * 0.46, theme["secondary"], transparency=12)
    # visualIntent is a renderer instruction, not copy to print on the slide.


def _photo_credit(slide, photo: PexelsPhoto, theme: dict[str, Any], x: float, y: float, width: float) -> None:
    box = _text(slide, x, y, width, 0.2, "", theme,
                size=8, color=theme["textSecondary"], align=PP_ALIGN.RIGHT)
    paragraph = box.text_frame.paragraphs[0]
    credit_runs = (
        ("Photo", photo.photo_url),
        (" by ", None),
        (photo.photographer, photo.photographer_url),
        (" on ", None),
        ("Pexels", "https://www.pexels.com"),
    )
    for label, url in credit_runs:
        run = paragraph.add_run()
        run.text = label
        _set_font(run, theme, 8, theme["textSecondary"])
        if url:
            run.hyperlink.address = url


def _render_slide(slide, design: SlideDesign, theme: dict[str, Any], width: float, height: float, index: int, count: int,
                  photo: PexelsPhoto | None = None) -> None:
    # Every slide receives its own content-matched photo as the full-slide
    # background; the themed overlay preserves contrast for all slide types.
    _background(slide, theme, width, height, index, photo)
    margin = SAFE_MARGIN
    if design.type == "cover":
        if design.eyebrow:
            _text(slide, margin + 0.1, 1.25, width - 2 * margin, 0.35, design.eyebrow.upper(), theme, size=12, color=theme["accent"], bold=True, align=PP_ALIGN.CENTER)
        _text(slide, margin + 0.25, 2.0, width - 2 * (margin + 0.25), 1.5, design.title or "", theme, size=40, bold=True, align=PP_ALIGN.CENTER)
        if design.subtitle or design.keyMessage:
            _text(slide, margin + 0.8, 3.75, width - 2 * (margin + 0.8), 0.8, design.subtitle or design.keyMessage or "", theme, size=19, color=theme["textSecondary"], align=PP_ALIGN.CENTER)
        _shape(slide, width / 2 - 0.38, 5.0, 0.76, 0.07, theme["accent"], rounded=False)
    elif design.type == "section":
        _text(slide, margin, 2.35, width - 2 * margin, 0.32, design.eyebrow or f"SECTION {index + 1:02d}", theme, size=12, color=theme["accent"], bold=True, align=PP_ALIGN.CENTER)
        _text(slide, margin + 0.35, 2.8, width - 2 * (margin + 0.35), 1.1, design.title or "", theme, size=36, bold=True, align=PP_ALIGN.CENTER)
        _text(slide, margin + 1.2, 4.05, width - 2 * (margin + 1.2), 0.55, design.keyMessage or design.subtitle or "", theme, size=17, color=theme["textSecondary"], align=PP_ALIGN.CENTER)
    elif design.type == "big-number":
        _header(slide, design, theme, width)
        _metric_cards(slide, design, theme, width, 2.35, hero=True)
    elif design.type == "metrics":
        top = _header(slide, design, theme, width)
        _metric_cards(slide, design, theme, width, top, hero=design.layoutVariant == "hero-metric")
    elif design.type in {"image-text", "full-image"}:
        top = _header(slide, design, theme, width)
        # The matching photo is already the page background. Do not repeat it
        # as an inset panel; reserve the content area for the actual narrative.
        body_width = width - 2 * margin
        if design.type == "full-image":
            _body_points(slide, design, theme, x=margin, y=top, w=body_width, h=height - top - 1.0)
        else:
            content_width = body_width * 0.68 if design.layoutVariant == "image-right" else body_width
            _body_points(slide, design, theme, x=margin, y=top, w=content_width, h=height - top - 1.0)
    elif design.type == "chart":
        top = _header(slide, design, theme, width)
        _chart(slide, design, theme, width, top, height - top - 0.8)
    elif design.type == "table":
        top = _header(slide, design, theme, width)
        _table(slide, design, theme, width, top, height - top - 1.0)
    elif design.type == "quote":
        _header(slide, design, theme, width, title_size=25)
        _shape(slide, margin + 0.1, 2.15, width - 2 * margin - 0.2, 3.35, theme["surface"], line=theme["border"])
        _text(slide, margin + 0.55, 2.55, width - 2 * margin - 1.1, 2.25, f"“{design.quote or ''}”", theme, size=25, color=theme["textPrimary"], bold=True, align=PP_ALIGN.CENTER)
        if design.attribution:
            _text(slide, margin + 0.55, 4.95, width - 2 * margin - 1.1, 0.35, design.attribution, theme, size=13, color=theme["muted"], align=PP_ALIGN.CENTER)
    elif design.type in {"timeline", "process"}:
        top = _header(slide, design, theme, width)
        items = design.timeline
        line_y = top + 0.6
        _shape(slide, margin + 0.25, line_y, width - 2 * margin - 0.5, 0.045, theme["border"], rounded=False)
        column_w = (width - 2 * margin) / max(1, len(items))
        for item_index, item in enumerate(items):
            x = margin + item_index * column_w
            _shape(slide, x + 0.15, line_y - 0.09, 0.22, 0.22, theme["accent"] if item_index == 0 else theme["primary"])
            _text(slide, x + 0.02, line_y + 0.34, column_w - 0.08, 0.28, item.label, theme, size=11, color=theme["accent"], bold=True)
            _text(slide, x + 0.02, line_y + 0.7, column_w - 0.08, 0.66, item.title, theme, size=15, bold=True, valign=MSO_ANCHOR.TOP)
            _text(slide, x + 0.02, line_y + 1.42, column_w - 0.08, 1.0, item.detail, theme, size=11, color=theme["textSecondary"], valign=MSO_ANCHOR.TOP)
    elif design.type in {"comparison", "cards"}:
        top = _header(slide, design, theme, width)
        points = design.supportingPoints or ([design.keyMessage] if design.keyMessage else [])
        columns = 3 if len(points) == 3 else 2
        gap = 0.18
        card_w = (width - 2 * margin - gap * (columns - 1)) / columns
        rows = max(1, (min(len(points), 4) + columns - 1) // columns)
        usable_bottom = height - 1.02
        card_h = min(2.85, (usable_bottom - top - 0.12 - gap * (rows - 1)) / rows)
        for point_index, point in enumerate(points[:4]):
            col, row = point_index % columns, point_index // columns
            x = margin + col * (card_w + gap)
            y = top + 0.12 + row * (card_h + gap)
            _shape(slide, x, y, card_w, card_h, theme["surface"], line=theme["border"])
            _shape(slide, x + 0.2, y + 0.24, 0.45, 0.055, theme["accent"] if point_index == 0 else theme["primary"], rounded=False)
            _text(slide, x + 0.2, y + 0.48, card_w - 0.4, max(0.45, card_h - 0.66), point, theme, size=16, color=theme["textSecondary"], valign=MSO_ANCHOR.TOP)
    else:
        top = _header(slide, design, theme, width)
        _body_points(slide, design, theme, x=margin, y=top, w=width - 2 * margin, h=height - top - 1.0)

    # Footer is deliberately quiet and stays inside the shared safe area.
    if design.sources:
        _text(slide, margin, height - 0.72, width - 2 * margin, 0.18, "来源：" + "；".join(design.sources), theme, size=7, color=theme["muted"])
    if photo:
        footer_width = width - 2 * margin
        _text(slide, margin, height - 0.48, footer_width * 0.58, 0.2,
              f"{design.title or ''}   ·   {index + 1:02d} / {count:02d}", theme, size=8, color=theme["muted"])
        _photo_credit(slide, photo, theme, margin + footer_width * 0.58, height - 0.48, footer_width * 0.42)
    else:
        _text(slide, margin, height - 0.48, width - 2 * margin, 0.2,
              f"{design.title or ''}   ·   {index + 1:02d} / {count:02d}", theme, size=8, color=theme["muted"])


def render_presentation(raw_design: PresentationDesign | dict[str, Any],
                        photo_assets: dict[str, PexelsPhoto] | None = None) -> bytes:
    design = raw_design if isinstance(raw_design, PresentationDesign) else PresentationDesign.model_validate(raw_design)
    width, height = CANVAS[design.aspectRatio]
    theme = resolve_theme(design.theme)
    presentation = Presentation()
    presentation.slide_width = Inches(width)
    presentation.slide_height = Inches(height)
    blank = presentation.slide_layouts[6]
    photo_assets = photo_assets or {}
    for index, slide_design in enumerate(design.slides):
        slide = presentation.slides.add_slide(blank)
        _render_slide(slide, slide_design, theme, width, height, index, len(design.slides),
                      photo_assets.get(slide_design.id))
        _assert_shapes_within_canvas(slide, width, height, slide_design.id)
    from io import BytesIO
    output = BytesIO()
    presentation.save(output)
    return output.getvalue()


def _assert_shapes_within_canvas(slide, width: float, height: float, slide_id: str) -> None:
    """Fail generation rather than ship any shape positioned outside the slide."""
    tolerance = Inches(0.015)
    canvas_width, canvas_height = Inches(width), Inches(height)
    for shape in slide.shapes:
        if (
            shape.left < -tolerance
            or shape.top < -tolerance
            or shape.left + shape.width > canvas_width + tolerance
            or shape.top + shape.height > canvas_height + tolerance
        ):
            raise ValueError(f"页面 {slide_id} 的元素超出幻灯片边界：{shape.name}")
