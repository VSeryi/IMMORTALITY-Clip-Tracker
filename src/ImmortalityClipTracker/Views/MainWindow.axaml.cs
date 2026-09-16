using Avalonia.Controls;
using ImmortalityClipTracker.ViewModels;

namespace ImmortalityClipTracker.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        MainViewModel model = new();
        DataContext = model;

        Opened += (_, _) =>
        {
            model.Storage = StorageProvider;
            model.Initialise();
        };
    }
}
