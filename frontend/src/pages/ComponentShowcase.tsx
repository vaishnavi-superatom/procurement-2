import { useState } from 'react';
import { Icon } from '@iconify/react';
import Card from '../components/Card';
import Carousel from '../components/Carousel';
import Tabs from '../components/Tabs';
import FileUpload from '../components/FileUpload';
import Input from '../components/Input';
import Textarea from '../components/Textarea';
import DatePicker from '../components/DatePicker';
import TimePicker from '../components/TimePicker';
import DateTimePicker from '../components/DateTimePicker';
import ColorPicker from '../components/ColorPicker';
import RangeSlider from '../components/RangeSlider';
import ReportViewer from '../components/ReportViewer';
import InvoiceBuilder from '../components/InvoiceBuilder';
import ReportScheduler from '../components/ReportScheduler';
import Checkbox from '../components/Checkbox';
import Gallery from '../components/Gallery';
import MarkdownPreview from '../components/MarkdownPreview';
import List from '../components/List';
import RichTextEditor from '../components/RichTextEditor';
// import MapboxWarehouseSelector from '../workflows/deadstock-marketing/MapboxWarehouseSelector';

const ComponentShowcase = () => {
  const [cardVariant, setCardVariant] = useState<'tags' | 'button'>('tags');
  const [carouselVariant, setCarouselVariant] = useState<'basic' | 'nav' | 'indicators' | 'vertical'>('basic');
  const [tabsVariant, setTabsVariant] = useState<'underline' | 'pills' | 'bordered'>('underline');
  const [fileUploadType, setFileUploadType] = useState<'image' | 'pdf'>('image');
  const [fileUploadMultiple, setFileUploadMultiple] = useState(true);
  const [inputSize, setInputSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [inputType, setInputType] = useState<'text' | 'email' | 'password' | 'number' | 'tel' | 'search'>('text');
  const [showPassword, setShowPassword] = useState(false);
  const [textareaSize, setTextareaSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [textareaVariant, setTextareaVariant] = useState<'basic' | 'charcount' | 'autoresize' | 'error'>('basic');
  const [textareaValue, setTextareaValue] = useState('');
  const [datePickerSize, setDatePickerSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [datePickerMode, setDatePickerMode] = useState<'single' | 'range'>('single');
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [timePickerSize, setTimePickerSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [timePickerFormat, setTimePickerFormat] = useState<'12h' | '24h'>('24h');
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [showSeconds, setShowSeconds] = useState(false);
  // DateTimePicker state
  const [dateTimePickerSize, setDateTimePickerSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [dateTimeFormat, setDateTimeFormat] = useState<'12h' | '24h'>('24h');
  const [selectedDateTime, setSelectedDateTime] = useState<Date | null>(null);
  // ColorPicker state
  const [colorPickerSize, setColorPickerSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [colorFormat, setColorFormat] = useState<'hex' | 'rgb' | 'hsl'>('hex');
  const [selectedColor, setSelectedColor] = useState('#3b82f6');
  const [showAlpha, setShowAlpha] = useState(false);
  // RangeSlider state
  const [sliderSize, setSliderSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [sliderColor, setSliderColor] = useState<'primary' | 'secondary' | 'accent' | 'success'>('primary');
  const [sliderMode, setSliderMode] = useState<'single' | 'range'>('single');
  const [sliderValue, setSliderValue] = useState(50);
  const [sliderRangeValue, setSliderRangeValue] = useState<[number, number]>([25, 75]);
  // ReportViewer state
  const [reportSize, setReportSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [reportOrientation, setReportOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [reportMode, setReportMode] = useState<'content' | 'pdf'>('content');
  const [reportPdfFile, setReportPdfFile] = useState<File | null>(null);
  const [checkboxSize, setCheckboxSize] = useState<'xs' | 'sm' | 'md' | 'lg'>('md');
  const [checkboxState, setCheckboxState] = useState<'unchecked' | 'checked' | 'disabled' | 'group'>('unchecked');
  const [selectedFruits, setSelectedFruits] = useState<string[]>(['apple']);
  const [galleryLayout, setGalleryLayout] = useState<'vertical' | 'horizontal'>('vertical');
  const [galleryColumns, setGalleryColumns] = useState<2 | 3 | 4 | 5>(3);
  const [galleryRowHeight, setGalleryRowHeight] = useState<'sm' | 'md' | 'lg'>('md');
  const [markdownSize, setMarkdownSize] = useState<'sm' | 'md' | 'lg'>('md');
  const [listVariant, setListVariant] = useState<'unordered' | 'ordered' | 'description' | 'checklist' | 'timeline' | 'steps'>('unordered');
  const [currentStep, setCurrentStep] = useState(1);
  const [checklistItems, setChecklistItems] = useState([
    { label: 'Create component library', checked: true },
    { label: 'Add DaisyUI styling', checked: true },
    { label: 'Write documentation', checked: false },
    { label: 'Deploy to production', checked: false },
  ]);
  const [editorContent, setEditorContent] = useState('<p>Start typing here...</p>');

  // Sample markdown content
  const sampleMarkdown = `# Welcome to MarkdownPreview

This component renders **markdown** and *HTML* content with beautiful DaisyUI styling.

## Features

- Supports **bold** and *italic* text
- ~~Strikethrough~~ text
- Inline \`code\` styling
- Tables, lists, and more!

### Code Blocks

\`\`\`javascript
const greeting = "Hello, World!";
console.log(greeting);
\`\`\`

### Links and Lists

Check out [DaisyUI](https://daisyui.com) for more components.

1. First ordered item
2. Second ordered item
3. Third ordered item

### Table Example

| Component | Status | Size |
|-----------|--------|------|
| Gallery | Done | 2KB |
| Tabs | Done | 1KB |
| Input | Done | 1.5KB |
| MarkdownPreview | Done | 3KB |

### Blockquotes

> This is a blockquote. It's great for highlighting important information or quotes from others.

---

That's it! Simple and clean markdown rendering.`;

  // Sample gallery images with different sizes
  const sampleImages = [
    { src: 'https://picsum.photos/800/600?random=1', caption: 'Landscape' },
    { src: 'https://picsum.photos/600/800?random=2', caption: 'Portrait' },
    { src: 'https://picsum.photos/1200/800?random=3', caption: 'Wide' },
    { src: 'https://picsum.photos/800/800?random=4', caption: 'Square' },
    { src: 'https://picsum.photos/1000/600?random=5', caption: 'Panoramic' },
    { src: 'https://picsum.photos/700/900?random=6', caption: 'Tall' },
    { src: 'https://picsum.photos/900/600?random=7', caption: 'Nature' },
    { src: 'https://picsum.photos/600/900?random=8', caption: 'City' },
    { src: 'https://picsum.photos/1100/700?random=9', caption: 'Architecture' },
    { src: 'https://picsum.photos/750/750?random=10', caption: 'Abstract' },
    { src: 'https://picsum.photos/850/550?random=11', caption: 'Travel' },
    { src: 'https://picsum.photos/550/850?random=12', caption: 'Food' },
  ];

  return (
    <div className="min-h-screen bg-base-200 p-6">
      {/* Header */}
      <div className="max-w-6xl mx-auto mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Icon icon="mdi:puzzle" className="w-8 h-8 text-primary" />
          <h1 className="text-3xl font-bold">Component Library</h1>
        </div>
        <p className="text-base-content/60">DaisyUI Components Showcase - Testing our custom components</p>
      </div>

      {/* Main Content with Tabs */}
      <div className="max-w-6xl mx-auto">
        <Tabs defaultValue="card" variant="bordered" size="lg">
          <Tabs.List alignment="center" className="mb-8 flex-wrap">
            <Tabs.Trigger value="card" icon="mdi:card-outline">Card</Tabs.Trigger>
            <Tabs.Trigger value="carousel" icon="mdi:view-carousel-outline">Carousel</Tabs.Trigger>
            <Tabs.Trigger value="tabs" icon="mdi:tab">Tabs</Tabs.Trigger>
            <Tabs.Trigger value="fileupload" icon="mdi:upload">FileUpload</Tabs.Trigger>
            <Tabs.Trigger value="input" icon="mdi:form-textbox">Input</Tabs.Trigger>
            <Tabs.Trigger value="textarea" icon="mdi:text-box-outline">Textarea</Tabs.Trigger>
            <Tabs.Trigger value="datepicker" icon="mdi:calendar">DatePicker</Tabs.Trigger>
            <Tabs.Trigger value="timepicker" icon="mdi:clock-outline">TimePicker</Tabs.Trigger>
            <Tabs.Trigger value="datetimepicker" icon="mdi:calendar-clock">DateTime</Tabs.Trigger>
            <Tabs.Trigger value="colorpicker" icon="mdi:palette">ColorPicker</Tabs.Trigger>
            <Tabs.Trigger value="rangeslider" icon="mdi:tune-vertical">RangeSlider</Tabs.Trigger>
            <Tabs.Trigger value="reportviewer" icon="mdi:file-document-outline">Report</Tabs.Trigger>
            <Tabs.Trigger value="invoice" icon="mdi:receipt-text">Invoice</Tabs.Trigger>
            <Tabs.Trigger value="scheduler" icon="mdi:calendar-clock">Scheduler</Tabs.Trigger>
            <Tabs.Trigger value="checkbox" icon="mdi:checkbox-marked">Checkbox</Tabs.Trigger>
            <Tabs.Trigger value="gallery" icon="mdi:image-multiple">Gallery</Tabs.Trigger>
            <Tabs.Trigger value="markdown" icon="mdi:language-markdown">Markdown</Tabs.Trigger>
            <Tabs.Trigger value="list" icon="mdi:format-list-bulleted">List</Tabs.Trigger>
            <Tabs.Trigger value="richtext" icon="mdi:format-text">RichText</Tabs.Trigger>
            <Tabs.Trigger value="mapbox" icon="mdi:map-marker-multiple">Mapbox</Tabs.Trigger>
          </Tabs.List>

          {/* Card Component Showcase */}
          <Tabs.Content value="card">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:card-outline" className="w-6 h-6" />
                  Card Component
                </h2>
                <p className="text-base-content/60 mb-6">
                  A generic card component with image, title, description, and optional tags or CTA button.
                </p>

                {/* Variant Selector */}
                <div className="flex gap-2 mb-6">
                  <button onClick={() => setCardVariant('tags')} className={`btn btn-sm ${cardVariant === 'tags' ? 'btn-primary' : 'btn-outline'}`}>With Tags</button>
                  <button onClick={() => setCardVariant('button')} className={`btn btn-sm ${cardVariant === 'button' ? 'btn-primary' : 'btn-outline'}`}>With Button</button>
                </div>

                {/* Card Preview */}
                <div className="bg-base-200 rounded-box p-8">
                  <div className="flex flex-wrap gap-6 justify-center">
                    {cardVariant === 'tags' ? (
                      <>
                        <Card title="KALLAX Shelf Unit" titleBadge="NEW" titleBadgeVariant="secondary" description="White, 77x147 cm. Perfect for books, decorations, and storage boxes." tags={['Furniture', 'Storage', 'Living Room']} />
                        <Card title="MALM Bed Frame" description="High bed frame with 4 storage boxes. Queen size, white stained oak." tags={['Bedroom', 'Storage']} />
                      </>
                    ) : (
                      <>
                        <Card title="BILLY Bookcase" titleBadge="SALE" titleBadgeVariant="error" description="Adjustable shelves; adapt space between shelves according to your needs." buttonText="Add to Cart" buttonVariant="primary" onButtonClick={() => alert('Added to cart!')} />
                        <Card title="POANG Armchair" description="Layer-glued bent beech frame gives comfortable resilience." buttonText="View Details" buttonVariant="secondary" onButtonClick={() => alert('Viewing details...')} />
                      </>
                    )}
                  </div>
                </div>

                {/* Code Example */}
                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<Card`}</code></pre>
                    <pre data-prefix="2"><code>{`  title="KALLAX Shelf Unit"`}</code></pre>
                    <pre data-prefix="3"><code>{`  titleBadge="NEW"`}</code></pre>
                    <pre data-prefix="4"><code>{`  description="White, 77x147 cm..."`}</code></pre>
                    <pre data-prefix="5"><code>{cardVariant === 'tags' ? `  tags={['Furniture', 'Storage']}` : `  buttonText="Add to Cart"`}</code></pre>
                    <pre data-prefix="6"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Carousel Component Showcase */}
          <Tabs.Content value="carousel">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:view-carousel-outline" className="w-6 h-6" />
                  Carousel Component
                </h2>
                <p className="text-base-content/60 mb-6">A flexible carousel supporting horizontal/vertical orientation, navigation buttons, and indicators.</p>

                <div className="flex flex-wrap gap-2 mb-6">
                  {(['basic', 'nav', 'indicators', 'vertical'] as const).map((v) => (
                    <button key={v} onClick={() => setCarouselVariant(v)} className={`btn btn-sm ${carouselVariant === v ? 'btn-primary' : 'btn-outline'}`}>{v}</button>
                  ))}
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="flex justify-center">
                    {carouselVariant === 'basic' && <Carousel className="max-w-md" bgColor="bg-neutral" />}
                    {carouselVariant === 'nav' && <Carousel className="max-w-2xl w-full" fullWidth showNavButtons />}
                    {carouselVariant === 'indicators' && <Carousel className="max-w-2xl w-full" fullWidth showIndicators indicatorType="bullets" />}
                    {carouselVariant === 'vertical' && <Carousel orientation="vertical" height="h-72" className="w-64" />}
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Tabs Component Showcase */}
          <Tabs.Content value="tabs">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:tab" className="w-6 h-6" />
                  Tabs Component
                </h2>
                <p className="text-base-content/60 mb-6">A compound component for tabbed content with multiple variants.</p>

                <div className="flex flex-wrap gap-2 mb-6">
                  {(['underline', 'pills', 'bordered'] as const).map((v) => (
                    <button key={v} onClick={() => setTabsVariant(v)} className={`btn btn-sm ${tabsVariant === v ? 'btn-primary' : 'btn-outline'}`}>{v}</button>
                  ))}
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <Tabs defaultValue="products" variant={tabsVariant}>
                    <Tabs.List>
                      <Tabs.Trigger value="products" icon="mdi:package-variant">Products</Tabs.Trigger>
                      <Tabs.Trigger value="orders" icon="mdi:cart">Orders</Tabs.Trigger>
                      <Tabs.Trigger value="customers" icon="mdi:account-group">Customers</Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="products"><p className="p-4">Products content here...</p></Tabs.Content>
                    <Tabs.Content value="orders"><p className="p-4">Orders content here...</p></Tabs.Content>
                    <Tabs.Content value="customers"><p className="p-4">Customers content here...</p></Tabs.Content>
                  </Tabs>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* FileUpload Component Showcase */}
          <Tabs.Content value="fileupload">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:upload" className="w-6 h-6" />
                  FileUpload Component
                </h2>
                <p className="text-base-content/60 mb-6">A drag & drop file upload component with preview support.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">File Type:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setFileUploadType('image')} className={`btn btn-sm ${fileUploadType === 'image' ? 'btn-primary' : 'btn-outline'}`}>Image</button>
                      <button onClick={() => setFileUploadType('pdf')} className={`btn btn-sm ${fileUploadType === 'pdf' ? 'btn-primary' : 'btn-outline'}`}>PDF</button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Multiple:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setFileUploadMultiple(false)} className={`btn btn-sm ${!fileUploadMultiple ? 'btn-secondary' : 'btn-outline'}`}>Single</button>
                      <button onClick={() => setFileUploadMultiple(true)} className={`btn btn-sm ${fileUploadMultiple ? 'btn-secondary' : 'btn-outline'}`}>Multiple</button>
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto">
                    <FileUpload key={`${fileUploadType}-${fileUploadMultiple}`} fileType={fileUploadType} multiple={fileUploadMultiple} maxSize={5} onUpload={(files) => console.log('Uploaded:', files)} />
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Input Component Showcase */}
          <Tabs.Content value="input">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:form-textbox" className="w-6 h-6" />
                  Input Component
                </h2>
                <p className="text-base-content/60 mb-6">A flexible input component with labels, icons, and validation states.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Type:</p>
                    <div className="flex flex-wrap gap-2">
                      {(['text', 'email', 'password', 'number', 'tel', 'search'] as const).map((t) => (
                        <button key={t} onClick={() => setInputType(t)} className={`btn btn-sm ${inputType === t ? 'btn-primary' : 'btn-outline'}`}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setInputSize(s)} className={`btn btn-sm ${inputSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto">
                    <Input
                      size={inputSize}
                      type={inputType === 'password' ? (showPassword ? 'text' : 'password') : inputType}
                      label={inputType.charAt(0).toUpperCase() + inputType.slice(1)}
                      placeholder={`Enter ${inputType}...`}
                      leftIcon={inputType === 'email' ? 'mdi:email-outline' : inputType === 'password' ? 'mdi:lock-outline' : inputType === 'search' ? 'mdi:magnify' : 'mdi:text'}
                      rightIcon={inputType === 'password' ? (showPassword ? 'mdi:eye-off-outline' : 'mdi:eye-outline') : undefined}
                      onRightIconClick={inputType === 'password' ? () => setShowPassword(!showPassword) : undefined}
                    />
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Textarea Component Showcase */}
          <Tabs.Content value="textarea">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:text-box-outline" className="w-6 h-6" />
                  Textarea Component
                </h2>
                <p className="text-base-content/60 mb-6">A multi-line text input with auto-resize, character count, and validation states.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Variant:</p>
                    <div className="flex flex-wrap gap-2">
                      {(['basic', 'charcount', 'autoresize', 'error'] as const).map((v) => (
                        <button key={v} onClick={() => setTextareaVariant(v)} className={`btn btn-sm ${textareaVariant === v ? 'btn-primary' : 'btn-outline'}`}>{v}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setTextareaSize(s)} className={`btn btn-sm ${textareaSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto">
                    {textareaVariant === 'basic' && <Textarea size={textareaSize} label="Description" placeholder="Enter your description..." helperText="Provide a detailed description" />}
                    {textareaVariant === 'charcount' && <Textarea size={textareaSize} label="Bio" placeholder="Tell us about yourself..." showCharCount maxLength={200} value={textareaValue} onChange={(e) => setTextareaValue(e.target.value)} />}
                    {textareaVariant === 'autoresize' && <Textarea size={textareaSize} label="Notes" placeholder="Start typing..." autoResize minRows={2} maxRows={8} />}
                    {textareaVariant === 'error' && <Textarea size={textareaSize} label="Required Field" placeholder="This field is required" error="This field cannot be empty" />}
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* DatePicker Component Showcase */}
          <Tabs.Content value="datepicker">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:calendar" className="w-6 h-6" />
                  DatePicker Component
                </h2>
                <p className="text-base-content/60 mb-6">A date picker with calendar dropdown. Supports single date and date range selection.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Mode:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setDatePickerMode('single')} className={`btn btn-sm ${datePickerMode === 'single' ? 'btn-primary' : 'btn-outline'}`}>Single</button>
                      <button onClick={() => setDatePickerMode('range')} className={`btn btn-sm ${datePickerMode === 'range' ? 'btn-primary' : 'btn-outline'}`}>Range</button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setDatePickerSize(s)} className={`btn btn-sm ${datePickerSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto space-y-4">
                    {datePickerMode === 'single' ? (
                      <DatePicker
                        size={datePickerSize}
                        mode="single"
                        label="Select Date"
                        placeholder="Choose a date..."
                        value={selectedDate}
                        onChange={(date) => setSelectedDate(date)}
                        helperText={selectedDate ? `Selected: ${selectedDate.toLocaleDateString()}` : 'Click to open calendar'}
                      />
                    ) : (
                      <DatePicker
                        size={datePickerSize}
                        mode="range"
                        label="Select Date Range"
                        placeholder="Choose dates..."
                        startDate={startDate}
                        endDate={endDate}
                        onRangeChange={(start, end) => {
                          setStartDate(start);
                          setEndDate(end);
                        }}
                        helperText={startDate && endDate ? `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}` : 'Select start and end dates'}
                      />
                    )}
                  </div>
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<DatePicker`}</code></pre>
                    <pre data-prefix="2"><code>{`  mode="${datePickerMode}"`}</code></pre>
                    <pre data-prefix="3"><code>{`  size="${datePickerSize}"`}</code></pre>
                    <pre data-prefix="4"><code>{`  label="Select Date"`}</code></pre>
                    <pre data-prefix="5"><code>{datePickerMode === 'single' ? `  onChange={(date) => setDate(date)}` : `  onRangeChange={(start, end) => {}}`}</code></pre>
                    <pre data-prefix="6"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* TimePicker Component Showcase */}
          <Tabs.Content value="timepicker">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:clock-outline" className="w-6 h-6" />
                  TimePicker Component
                </h2>
                <p className="text-base-content/60 mb-6">A time picker with scrollable hour/minute selection. Supports 12h and 24h formats.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Format:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setTimePickerFormat('24h')} className={`btn btn-sm ${timePickerFormat === '24h' ? 'btn-primary' : 'btn-outline'}`}>24h</button>
                      <button onClick={() => setTimePickerFormat('12h')} className={`btn btn-sm ${timePickerFormat === '12h' ? 'btn-primary' : 'btn-outline'}`}>12h</button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setTimePickerSize(s)} className={`btn btn-sm ${timePickerSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Show Seconds:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setShowSeconds(false)} className={`btn btn-sm ${!showSeconds ? 'btn-primary' : 'btn-outline'}`}>No</button>
                      <button onClick={() => setShowSeconds(true)} className={`btn btn-sm ${showSeconds ? 'btn-primary' : 'btn-outline'}`}>Yes</button>
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto">
                    <TimePicker
                      size={timePickerSize}
                      format={timePickerFormat}
                      label="Select Time"
                      placeholder="Choose a time..."
                      value={selectedTime}
                      onChange={(time) => setSelectedTime(time)}
                      showSeconds={showSeconds}
                      helperText={selectedTime ? `Selected: ${selectedTime}` : 'Click to open time picker'}
                    />
                  </div>
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<TimePicker`}</code></pre>
                    <pre data-prefix="2"><code>{`  format="${timePickerFormat}"`}</code></pre>
                    <pre data-prefix="3"><code>{`  size="${timePickerSize}"`}</code></pre>
                    <pre data-prefix="4"><code>{`  showSeconds={${showSeconds}}`}</code></pre>
                    <pre data-prefix="5"><code>{`  onChange={(time) => setTime(time)}`}</code></pre>
                    <pre data-prefix="6"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* DateTimePicker Component Showcase */}
          <Tabs.Content value="datetimepicker">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:calendar-clock" className="w-6 h-6" />
                  DateTimePicker Component
                </h2>
                <p className="text-base-content/60 mb-6">A combined date and time picker with tabbed interface. Supports 12h and 24h formats.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Time Format:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setDateTimeFormat('24h')} className={`btn btn-sm ${dateTimeFormat === '24h' ? 'btn-primary' : 'btn-outline'}`}>24h</button>
                      <button onClick={() => setDateTimeFormat('12h')} className={`btn btn-sm ${dateTimeFormat === '12h' ? 'btn-primary' : 'btn-outline'}`}>12h</button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setDateTimePickerSize(s)} className={`btn btn-sm ${dateTimePickerSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto">
                    <DateTimePicker
                      size={dateTimePickerSize}
                      timeFormat={dateTimeFormat}
                      label="Select Date & Time"
                      placeholder="Choose date and time..."
                      value={selectedDateTime}
                      onChange={(dt) => setSelectedDateTime(dt)}
                      helperText={selectedDateTime ? `Selected: ${selectedDateTime.toLocaleString()}` : 'Click to open picker'}
                    />
                  </div>
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<DateTimePicker`}</code></pre>
                    <pre data-prefix="2"><code>{`  timeFormat="${dateTimeFormat}"`}</code></pre>
                    <pre data-prefix="3"><code>{`  size="${dateTimePickerSize}"`}</code></pre>
                    <pre data-prefix="4"><code>{`  value={selectedDateTime}`}</code></pre>
                    <pre data-prefix="5"><code>{`  onChange={(dt) => setSelectedDateTime(dt)}`}</code></pre>
                    <pre data-prefix="6"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* ColorPicker Component Showcase */}
          <Tabs.Content value="colorpicker">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:palette" className="w-6 h-6" />
                  ColorPicker Component
                </h2>
                <p className="text-base-content/60 mb-6">A color picker with gradient selector, preset swatches, and multiple output formats.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Format:</p>
                    <div className="flex gap-2">
                      {(['hex', 'rgb', 'hsl'] as const).map((f) => (
                        <button key={f} onClick={() => setColorFormat(f)} className={`btn btn-sm ${colorFormat === f ? 'btn-primary' : 'btn-outline'}`}>{f.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setColorPickerSize(s)} className={`btn btn-sm ${colorPickerSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Alpha:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setShowAlpha(false)} className={`btn btn-sm ${!showAlpha ? 'btn-primary' : 'btn-outline'}`}>No</button>
                      <button onClick={() => setShowAlpha(true)} className={`btn btn-sm ${showAlpha ? 'btn-primary' : 'btn-outline'}`}>Yes</button>
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto">
                    <ColorPicker
                      size={colorPickerSize}
                      format={colorFormat}
                      label="Choose Color"
                      value={selectedColor}
                      onChange={(color) => setSelectedColor(color)}
                      onChangeComplete={(color) => console.log('Color selected:', color)}
                      showAlpha={showAlpha}
                      helperText={`Selected: ${selectedColor}`}
                    />
                  </div>
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<ColorPicker`}</code></pre>
                    <pre data-prefix="2"><code>{`  format="${colorFormat}"`}</code></pre>
                    <pre data-prefix="3"><code>{`  size="${colorPickerSize}"`}</code></pre>
                    <pre data-prefix="4"><code>{`  showAlpha={${showAlpha}}`}</code></pre>
                    <pre data-prefix="5"><code>{`  onChange={(color) => setColor(color)}`}</code></pre>
                    <pre data-prefix="6"><code>{`  onChangeComplete={(color) => saveColor(color)}`}</code></pre>
                    <pre data-prefix="7"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* RangeSlider Component Showcase */}
          <Tabs.Content value="rangeslider">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:tune-vertical" className="w-6 h-6" />
                  RangeSlider Component
                </h2>
                <p className="text-base-content/60 mb-6">A range slider with single value and dual-handle range selection modes.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Mode:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setSliderMode('single')} className={`btn btn-sm ${sliderMode === 'single' ? 'btn-primary' : 'btn-outline'}`}>Single</button>
                      <button onClick={() => setSliderMode('range')} className={`btn btn-sm ${sliderMode === 'range' ? 'btn-primary' : 'btn-outline'}`}>Range</button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setSliderSize(s)} className={`btn btn-sm ${sliderSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Color:</p>
                    <div className="flex gap-2">
                      {(['primary', 'secondary', 'accent', 'success'] as const).map((c) => (
                        <button key={c} onClick={() => setSliderColor(c)} className={`btn btn-sm ${sliderColor === c ? 'btn-primary' : 'btn-outline'}`}>{c}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto space-y-8">
                    {sliderMode === 'single' ? (
                      <RangeSlider
                        size={sliderSize}
                        color={sliderColor}
                        label="Volume"
                        value={sliderValue}
                        onChange={(val) => setSliderValue(val)}
                        onChangeEnd={(val) => console.log('Value committed:', val)}
                        min={0}
                        max={100}
                        step={1}
                        showMinMax
                        showTicks
                        tickCount={5}
                        formatValue={(v) => `${v}%`}
                      />
                    ) : (
                      <RangeSlider
                        size={sliderSize}
                        color={sliderColor}
                        label="Price Range"
                        range
                        rangeValue={sliderRangeValue}
                        onRangeChange={(val) => setSliderRangeValue(val)}
                        onChangeEnd={(val) => console.log('Range committed:', val)}
                        min={0}
                        max={1000}
                        step={10}
                        showMinMax
                        formatValue={(v) => `$${v}`}
                      />
                    )}
                  </div>
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<RangeSlider`}</code></pre>
                    <pre data-prefix="2"><code>{`  ${sliderMode === 'range' ? 'range' : ''}`}</code></pre>
                    <pre data-prefix="3"><code>{`  size="${sliderSize}"`}</code></pre>
                    <pre data-prefix="4"><code>{`  color="${sliderColor}"`}</code></pre>
                    <pre data-prefix="5"><code>{sliderMode === 'single' ? `  value={${sliderValue}}` : `  rangeValue={[${sliderRangeValue[0]}, ${sliderRangeValue[1]}]}`}</code></pre>
                    <pre data-prefix="6"><code>{sliderMode === 'single' ? `  onChange={(val) => setValue(val)}` : `  onRangeChange={(val) => setRange(val)}`}</code></pre>
                    <pre data-prefix="7"><code>{`  onChangeEnd={(val) => saveValue(val)}`}</code></pre>
                    <pre data-prefix="8"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* ReportViewer Component Showcase */}
          <Tabs.Content value="reportviewer">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:file-document-outline" className="w-6 h-6" />
                  ReportViewer Component
                </h2>
                <p className="text-base-content/60 mb-6">An A4-sized printable report viewer with toolbar, pagination, and print support.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Mode:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setReportMode('content')} className={`btn btn-sm ${reportMode === 'content' ? 'btn-primary' : 'btn-outline'}`}>Content</button>
                      <button onClick={() => setReportMode('pdf')} className={`btn btn-sm ${reportMode === 'pdf' ? 'btn-primary' : 'btn-outline'}`}>PDF</button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Orientation:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setReportOrientation('portrait')} className={`btn btn-sm ${reportOrientation === 'portrait' ? 'btn-primary' : 'btn-outline'}`}>Portrait</button>
                      <button onClick={() => setReportOrientation('landscape')} className={`btn btn-sm ${reportOrientation === 'landscape' ? 'btn-primary' : 'btn-outline'}`}>Landscape</button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setReportSize(s)} className={`btn btn-sm ${reportSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  {reportMode === 'pdf' ? (
                    <ReportViewer
                      mode="pdf"
                      pdfFile={reportPdfFile}
                      allowPdfUpload={true}
                      onPdfFileChange={setReportPdfFile}
                      title="PDF Document"
                      size={reportSize}
                      orientation={reportOrientation}
                      onPrint={() => console.log('Print PDF triggered')}
                      onDownload={() => console.log('Download PDF triggered')}
                      onShare={() => console.log('Share PDF triggered')}
                    />
                  ) : (
                  <ReportViewer
                    title="Sales Report Q4 2024"
                    subtitle="Quarterly Performance Summary"
                    size={reportSize}
                    orientation={reportOrientation}
                    date={new Date().toLocaleDateString()}
                    reportId="RPT-2024-Q4-001"
                    pages={[
                      {
                        id: 'page1',
                        content: (
                          <div className="space-y-6">
                            <div>
                              <h2 className="text-xl font-bold mb-4 text-gray-900">Executive Summary</h2>
                              <p className="text-gray-700">This quarterly report provides a comprehensive overview of sales performance across all regions. The data presented reflects significant growth in key markets and identifies opportunities for expansion.</p>
                            </div>
                            <div className="grid grid-cols-3 gap-4">
                              <div className="bg-gray-100 p-4 rounded-lg text-center">
                                <div className="text-2xl font-bold text-blue-600">$2.4M</div>
                                <div className="text-xs text-gray-500">Total Revenue</div>
                              </div>
                              <div className="bg-gray-100 p-4 rounded-lg text-center">
                                <div className="text-2xl font-bold text-green-600">+18.5%</div>
                                <div className="text-xs text-gray-500">Growth Rate</div>
                              </div>
                              <div className="bg-gray-100 p-4 rounded-lg text-center">
                                <div className="text-2xl font-bold text-cyan-600">1,234</div>
                                <div className="text-xs text-gray-500">New Customers</div>
                              </div>
                            </div>
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="bg-gray-100">
                                  <th className="text-left p-2 font-semibold text-gray-700">Region</th>
                                  <th className="text-left p-2 font-semibold text-gray-700">Sales</th>
                                  <th className="text-left p-2 font-semibold text-gray-700">Change</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr className="border-b border-gray-200"><td className="p-2 text-gray-800">North America</td><td className="p-2 text-gray-800">$980,000</td><td className="p-2 text-green-600">+22%</td></tr>
                                <tr className="border-b border-gray-200"><td className="p-2 text-gray-800">Europe</td><td className="p-2 text-gray-800">$720,000</td><td className="p-2 text-green-600">+15%</td></tr>
                                <tr className="border-b border-gray-200"><td className="p-2 text-gray-800">Asia Pacific</td><td className="p-2 text-gray-800">$540,000</td><td className="p-2 text-green-600">+28%</td></tr>
                                <tr className="border-b border-gray-200"><td className="p-2 text-gray-800">Latin America</td><td className="p-2 text-gray-800">$160,000</td><td className="p-2 text-red-600">-5%</td></tr>
                              </tbody>
                            </table>
                          </div>
                        )
                      },
                      {
                        id: 'page2',
                        content: (
                          <div className="space-y-6">
                            <div>
                              <h2 className="text-xl font-bold mb-4 text-gray-900">Regional Analysis</h2>
                              <p className="text-gray-700">Detailed breakdown of performance metrics by region, highlighting key drivers of growth and areas requiring attention.</p>
                            </div>
                            <div className="space-y-4">
                              <div className="border border-gray-300 rounded-lg p-4">
                                <h3 className="font-semibold mb-2 text-gray-900">North America</h3>
                                <p className="text-sm text-gray-600">Strong performance driven by enterprise accounts. Focus on mid-market expansion recommended.</p>
                                <div className="mt-2 flex gap-4 text-sm">
                                  <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">Top Performer</span>
                                  <span className="text-gray-600">Target: $900K | Actual: $980K</span>
                                </div>
                              </div>
                              <div className="border border-gray-300 rounded-lg p-4">
                                <h3 className="font-semibold mb-2 text-gray-900">Europe</h3>
                                <p className="text-sm text-gray-600">Steady growth with particular strength in Germany and UK markets.</p>
                                <div className="mt-2 flex gap-4 text-sm">
                                  <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-medium">On Track</span>
                                  <span className="text-gray-600">Target: $700K | Actual: $720K</span>
                                </div>
                              </div>
                              <div className="border border-gray-300 rounded-lg p-4">
                                <h3 className="font-semibold mb-2 text-gray-900">Asia Pacific</h3>
                                <p className="text-sm text-gray-600">Fastest growing region. Investment in local partnerships yielding results.</p>
                                <div className="mt-2 flex gap-4 text-sm">
                                  <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">Exceeding</span>
                                  <span className="text-gray-600">Target: $450K | Actual: $540K</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      }
                    ]}
                    onPrint={() => console.log('Print triggered')}
                    onDownload={() => console.log('Download triggered')}
                    onShare={() => console.log('Share triggered')}
                  />
                  )}
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<ReportViewer`}</code></pre>
                    <pre data-prefix="2"><code>{`  title="Sales Report Q4 2024"`}</code></pre>
                    <pre data-prefix="3"><code>{`  orientation="${reportOrientation}"`}</code></pre>
                    <pre data-prefix="4"><code>{`  size="${reportSize}"`}</code></pre>
                    <pre data-prefix="5"><code>{`  date="2024-12-08"`}</code></pre>
                    <pre data-prefix="6"><code>{`  reportId="RPT-001"`}</code></pre>
                    <pre data-prefix="7"><code>{`  pages={[{ id: 'page1', content: <div>...</div> }]}`}</code></pre>
                    <pre data-prefix="8"><code>{`  onPrint={() => console.log('Print')}`}</code></pre>
                    <pre data-prefix="9"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* InvoiceBuilder Component Showcase */}
          <Tabs.Content value="invoice">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:receipt-text" className="w-6 h-6" />
                  InvoiceBuilder Component
                </h2>
                <p className="text-base-content/60 mb-6">Create and edit invoices with line items, tax calculations, and PDF export.</p>

                <div className="bg-base-200 rounded-box p-4">
                  <InvoiceBuilder
                    initialData={{
                      invoiceNumber: 'INV-2024-001',
                      companyName: 'IKEA AB',
                      companyAddress: 'Älmhult, Sweden',
                      companyEmail: 'billing@ikea.com',
                      customerName: 'John Doe',
                      customerEmail: 'john@example.com',
                      items: [
                        { id: '1', description: 'KALLAX Shelf Unit', quantity: 2, unitPrice: 69.99 },
                        { id: '2', description: 'MALM Bed Frame', quantity: 1, unitPrice: 199.00 },
                      ],
                      taxRate: 8.5,
                    }}
                    onSave={(data) => console.log('Invoice saved:', data)}
                    onExportPdf={(data) => console.log('Export PDF:', data)}
                    onSend={(data) => console.log('Send invoice:', data)}
                  />
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<InvoiceBuilder`}</code></pre>
                    <pre data-prefix="2"><code>{`  initialData={{ invoiceNumber: 'INV-001', ... }}`}</code></pre>
                    <pre data-prefix="3"><code>{`  onSave={(data) => saveInvoice(data)}`}</code></pre>
                    <pre data-prefix="4"><code>{`  onExportPdf={(data) => exportPdf(data)}`}</code></pre>
                    <pre data-prefix="5"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* ReportScheduler Component Showcase */}
          <Tabs.Content value="scheduler">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:calendar-clock" className="w-6 h-6" />
                  ReportScheduler Component
                </h2>
                <p className="text-base-content/60 mb-6">Schedule automated report generation and delivery via email, Slack, or cloud storage.</p>

                <div className="bg-base-200 rounded-box p-4">
                  <ReportScheduler
                    initialConfig={{
                      name: 'Weekly Sales Report',
                      frequency: 'weekly',
                      dayOfWeek: 1,
                      time: '09:00',
                      timezone: 'America/New_York',
                      format: 'pdf',
                      deliveryMethod: 'email',
                      recipients: ['team@company.com'],
                    }}
                    onSave={(config) => console.log('Schedule saved:', config)}
                    onTest={(config) => console.log('Test schedule:', config)}
                    showDelete={true}
                    onDelete={() => console.log('Delete schedule')}
                  />
                </div>

                <div className="mt-6">
                  <h3 className="font-semibold mb-2">Usage:</h3>
                  <div className="mockup-code">
                    <pre data-prefix="1"><code>{`<ReportScheduler`}</code></pre>
                    <pre data-prefix="2"><code>{`  initialConfig={{ frequency: 'weekly', ... }}`}</code></pre>
                    <pre data-prefix="3"><code>{`  onSave={(config) => saveSchedule(config)}`}</code></pre>
                    <pre data-prefix="4"><code>{`  onTest={(config) => testNow(config)}`}</code></pre>
                    <pre data-prefix="5"><code>{`/>`}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Checkbox Component Showcase */}
          <Tabs.Content value="checkbox">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:checkbox-marked" className="w-6 h-6" />
                  Checkbox Component
                </h2>
                <p className="text-base-content/60 mb-6">A checkbox component with labels and group support.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Example:</p>
                    <div className="flex flex-wrap gap-2">
                      {(['unchecked', 'checked', 'disabled', 'group'] as const).map((s) => (
                        <button key={s} onClick={() => setCheckboxState(s)} className={`btn btn-sm ${checkboxState === s ? 'btn-primary' : 'btn-outline'}`}>{s}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setCheckboxSize(s)} className={`btn btn-sm ${checkboxSize === s ? 'btn-secondary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-md mx-auto">
                    {checkboxState === 'unchecked' && <Checkbox id="demo-unchecked" size={checkboxSize} label="Enable notifications" className="checkbox-success" />}
                    {checkboxState === 'checked' && <Checkbox id="demo-checked" size={checkboxSize} label="I agree to terms" defaultChecked className="checkbox-success" />}
                    {checkboxState === 'disabled' && <Checkbox id="demo-disabled" size={checkboxSize} label="Premium feature (disabled)" disabled className="checkbox-success" />}
                    {checkboxState === 'group' && (
                      <Checkbox.Group label="Select fruits:" helperText={`Selected: ${selectedFruits.join(', ') || 'none'}`} orientation="horizontal">
                        {['apple', 'banana', 'orange', 'mango'].map((fruit) => (
                          <Checkbox key={fruit} id={`fruit-${fruit}`} size={checkboxSize} className="checkbox-success" label={fruit.charAt(0).toUpperCase() + fruit.slice(1)} checked={selectedFruits.includes(fruit)} onChange={(e) => e.target.checked ? setSelectedFruits([...selectedFruits, fruit]) : setSelectedFruits(selectedFruits.filter((f) => f !== fruit))} />
                        ))}
                      </Checkbox.Group>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Gallery Component Showcase */}
          <Tabs.Content value="gallery">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:image-multiple" className="w-6 h-6" />
                  Gallery Component
                </h2>
                <p className="text-base-content/60 mb-6">Masonry gallery with vertical and horizontal layouts.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Layout:</p>
                    <div className="flex gap-2">
                      <button onClick={() => setGalleryLayout('vertical')} className={`btn btn-sm ${galleryLayout === 'vertical' ? 'btn-primary' : 'btn-outline'}`}>Vertical</button>
                      <button onClick={() => setGalleryLayout('horizontal')} className={`btn btn-sm ${galleryLayout === 'horizontal' ? 'btn-primary' : 'btn-outline'}`}>Horizontal</button>
                    </div>
                  </div>
                  {galleryLayout === 'vertical' && (
                    <div>
                      <p className="text-sm text-base-content/60 mb-2">Columns:</p>
                      <div className="flex gap-2">
                        {([2, 3, 4, 5] as const).map((c) => (
                          <button key={c} onClick={() => setGalleryColumns(c)} className={`btn btn-sm ${galleryColumns === c ? 'btn-secondary' : 'btn-outline'}`}>{c}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <Gallery images={sampleImages} layout={galleryLayout} columns={galleryColumns} rowHeight={galleryRowHeight} gap="md" />
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Markdown Preview Component Showcase */}
          <Tabs.Content value="markdown">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:language-markdown" className="w-6 h-6" />
                  MarkdownPreview Component
                </h2>
                <p className="text-base-content/60 mb-6">Renders markdown or HTML content as styled JSX.</p>

                <div className="flex flex-wrap gap-6 mb-6">
                  <div>
                    <p className="text-sm text-base-content/60 mb-2">Size:</p>
                    <div className="flex gap-2">
                      {(['sm', 'md', 'lg'] as const).map((s) => (
                        <button key={s} onClick={() => setMarkdownSize(s)} className={`btn btn-sm ${markdownSize === s ? 'btn-primary' : 'btn-outline'}`}>{s.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  <MarkdownPreview content={sampleMarkdown} size={markdownSize} />
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* List Component Showcase */}
          <Tabs.Content value="list">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:format-list-bulleted" className="w-6 h-6" />
                  List Component
                </h2>
                <p className="text-base-content/60 mb-6">Versatile list with multiple variants.</p>

                <div className="flex flex-wrap gap-2 mb-6">
                  {(['unordered', 'ordered', 'description', 'checklist', 'timeline', 'steps'] as const).map((v) => (
                    <button key={v} onClick={() => setListVariant(v)} className={`btn btn-sm ${listVariant === v ? 'btn-primary' : 'btn-outline'}`}>{v}</button>
                  ))}
                </div>

                <div className="bg-base-200 rounded-box p-8">
                  {listVariant === 'unordered' && <List variant="unordered" items={['First item', 'Second item', 'Third item']} />}
                  {listVariant === 'ordered' && <List variant="ordered" items={['Install dependencies', 'Configure project', 'Build']} />}
                  {listVariant === 'description' && <List variant="description" items={[{ term: 'React', description: 'A JavaScript library' }, { term: 'TypeScript', description: 'Typed JavaScript' }]} />}
                  {listVariant === 'checklist' && <List variant="checklist" items={checklistItems.map((item, i) => ({ ...item, onChange: (checked: boolean) => { const newItems = [...checklistItems]; newItems[i].checked = checked; setChecklistItems(newItems); } }))} />}
                  {listVariant === 'timeline' && <List variant="timeline" items={[{ title: 'Project Started', time: 'Jan 2024', content: 'Initial setup', color: 'primary' as const }, { title: 'Launch', time: 'Jun 2024', content: 'Public release' }]} />}
                  {listVariant === 'steps' && <List variant="steps" currentStep={currentStep} horizontal items={[{ label: 'Register' }, { label: 'Plan' }, { label: 'Payment' }, { label: 'Complete' }]} />}
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* RichTextEditor Component Showcase */}
          <Tabs.Content value="richtext">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:format-text" className="w-6 h-6" />
                  RichTextEditor Component
                </h2>
                <p className="text-base-content/60 mb-6">WYSIWYG rich text editor with formatting toolbar.</p>

                <div className="bg-base-200 rounded-box p-8">
                  <div className="max-w-3xl mx-auto">
                    <RichTextEditor content={editorContent} placeholder="Start typing your content..." onChange={(html) => setEditorContent(html)} />
                  </div>
                </div>
              </div>
            </div>
          </Tabs.Content>

          {/* Mapbox Component Showcase */}
          <Tabs.Content value="mapbox">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-2">
                  <Icon icon="mdi:map-marker-multiple" className="w-6 h-6" />
                  MapboxWarehouseSelector Component
                </h2>
                <p className="text-base-content/60 mb-6">Interactive Mapbox map showing all IKEA US stores with inventory data.</p>

                <div className="bg-base-200 rounded-box p-4">
                  {/* <MapboxWarehouseSelector title="IKEA Store Locations" subtitle="Select a store to view inventory" onStoreSelect={(store: any) => console.log('Selected store:', store)} /> */}
                  <div className="text-base-content/50 italic text-center">Mapbox selector is disabled (workflow missing)</div>
                </div>
              </div>
            </div>
          </Tabs.Content>
        </Tabs>
      </div>
    </div>
  );
};

export default ComponentShowcase;
